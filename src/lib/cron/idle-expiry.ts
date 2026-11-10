import "server-only";
import { and, asc, lte, not, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { orderItems, orders, tableSessions } from "@/db/schema";
import { IDLE_EXPIRY_MINUTES } from "@/lib/session-idle";

/**
 * Spec 06's idle expiry, run by the scheduled job (S-35) as app_system, across
 * every restaurant: an open session with no activity for 90 minutes closes
 * (`close_reason = idle_expiry`, `closed_by` null), measured from
 * `last_activity_at`, not from when it opened. One with a line still in play
 * (placed, cooking or done) is skipped, not refused: the closure gate would
 * refuse it, so it is left open and the floor view flags it (src/lib/floor.ts).
 * Not audited (proposed): spec 01's list doesn't name it, and `close_reason`
 * records it on the session.
 *
 * Safe to overlap and to repeat, like the other tasks. Each batch takes the due
 * sessions with FOR NO KEY UPDATE SKIP LOCKED, so two runs never take the same
 * one, and the UPDATE repeats the whole condition (`status = 'open'`, idle,
 * nothing in play), naming each session by its restaurant_id as well as its id
 * (spec 01, System routes).
 *
 * Race-safe with an order arriving at the same moment, by the session's row: an
 * order marks the session active by updating that row, and a line's insert takes
 * it FOR SHARE (order_items_session_open). An order in first holds the row, so
 * the job passes over the session (SKIP LOCKED); an order second waits for the
 * job's transaction and then finds the session closed (placeOrder's
 * `session_changed`). The closure gate (0045) still stands behind it. It refuses
 * every close under REPEATABLE READ, so the batches run under READ COMMITTED.
 *
 * The job finds open sessions on table_sessions_one_open_per_table, which holds
 * only open ones, so it never reads the closed history, and checks each one's
 * lines through its orders. `now` is a parameter so a test can pick the moment.
 */

/** Sessions per transaction, and transactions per run. */
const BATCH_SIZE = 200;
const MAX_BATCHES = 25;
/** The job's other tasks share its 300 seconds; this one is all database work. */
const TIME_BUDGET_MS = 30_000;

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Due = { restaurantId: string; id: string };

/**
 * Whether one of the session's lines is still in play, read through the
 * session's own orders (orders_restaurant_id_session_id_placed_at_index). The
 * `offset 0` keeps it a per-session probe: without it Postgres may turn NOT
 * EXISTS into an anti-join that hashes the whole orders table, history and all,
 * while that table is small enough for a scan to look cheap (EXPLAIN-tested).
 */
const inPlay = sql`exists (
  select from ${orders}
  join ${orderItems}
    on ${orderItems.restaurantId} = ${orders.restaurantId} and ${orderItems.orderId} = ${orders.id}
  where ${orders.restaurantId} = ${tableSessions.restaurantId}
    and ${orders.sessionId} = ${tableSessions.id}
    and ${orderItems.inPlay}
  offset 0
)`;

/** Open, idle since the cutoff, and nothing in play: what the job may close. */
function due(now: Date) {
  const cutoff = new Date(now.getTime() - IDLE_EXPIRY_MINUTES * 60_000);
  // A literal, not a parameter, so the planner can match the partial index's predicate.
  return and(
    sql`${tableSessions.status} = 'open'`,
    lte(tableSessions.lastActivityAt, cutoff),
    not(inPlay),
  )!;
}

/** The next batch of sessions due to close, locked, skipping any another run or an order holds. */
export const idleSessions = (tx: Transaction, now: Date) =>
  tx
    .select({ restaurantId: tableSessions.restaurantId, id: tableSessions.id })
    .from(tableSessions)
    .where(due(now))
    .orderBy(asc(tableSessions.lastActivityAt))
    .limit(BATCH_SIZE)
    .for("no key update", { of: tableSessions, skipLocked: true });

/** Closes these sessions, each still only if it is due. Returns how many closed. */
export async function closeSessions(tx: Transaction, rows: readonly Due[], now: Date) {
  if (rows.length === 0) return 0;
  const { rowCount } = await tx
    .update(tableSessions)
    .set({ status: "closed", closedAt: now, closeReason: "idle_expiry" })
    .where(
      and(
        sql`(${tableSessions.restaurantId}, ${tableSessions.id}) in (${sql.join(
          rows.map(({ restaurantId, id }) => sql`(${restaurantId}::uuid, ${id}::uuid)`),
          sql`, `,
        )})`,
        due(now),
      ),
    );
  return rowCount ?? 0;
}

export async function closeIdleSessions(
  db: Database,
  now: Date,
  { budgetMs = TIME_BUDGET_MS }: { budgetMs?: number } = {},
): Promise<number> {
  const deadline = Date.now() + budgetMs;
  let closed = 0;
  for (let batch = 0; batch < MAX_BATCHES && Date.now() < deadline; batch++) {
    const { taken, changed } = await db.transaction(
      async (tx) => {
        const rows = await idleSessions(tx, now);
        return { taken: rows.length, changed: await closeSessions(tx, rows, now) };
      },
      { isolationLevel: "read committed" },
    );
    closed += changed;
    if (taken < BATCH_SIZE) break;
  }
  return closed;
}
