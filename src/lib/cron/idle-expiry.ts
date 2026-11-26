import "server-only";
import { and, asc, inArray, lte, not, sql } from "drizzle-orm";
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
 * only open ones, so it never reads the closed history, and checks each one
 * against its restaurant's lines in play (see inPlay). `now` is a parameter so a
 * test can pick the moment.
 */

/** Sessions per transaction, and transactions per run. */
const BATCH_SIZE = 200;
const MAX_BATCHES = 25;
/** The job's other tasks share its 300 seconds; this one is all database work. */
const TIME_BUDGET_MS = 30_000;

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Due = { restaurantId: string; id: string };

/**
 * Whether one of the session's lines is still in play: the restaurant's lines in
 * play (order_items_in_play, which holds only those), each checked against its
 * own order. Shaped so that no plan reads a restaurant's history:
 *
 * - The order is probed by the line's key as well as the session, so every index
 *   on orders serves it with two columns: (restaurant_id, id), (restaurant_id,
 *   session_id, placed_at) or the primary key. None reads more than this
 *   session's orders. A probe of the session's orders by (restaurant_id,
 *   session_id) alone is not enough: on stale statistics (one or two orders per
 *   restaurant) Postgres served it from orders_restaurant_id_id_unique on
 *   restaurant_id only, filtering session_id, and so read the restaurant's whole
 *   order history once per open session (EXPLAIN-tested).
 * - Each `offset 0` keeps its subquery a per-row probe. Without the outer one,
 *   NOT EXISTS may become an anti-join hashing every line in play or the whole
 *   orders table; without the inner one, the order check may be pulled up into a
 *   join that probes orders by restaurant again.
 *
 * Reads, per open session, the restaurant's lines in play: live rows only.
 */
const inPlay = sql`exists (
  select from ${orderItems}
  where ${orderItems.restaurantId} = ${tableSessions.restaurantId}
    and ${orderItems.inPlay}
    and exists (
      select from ${orders}
      where ${orders.restaurantId} = ${orderItems.restaurantId}
        and ${orders.id} = ${orderItems.orderId}
        and ${orders.sessionId} = ${tableSessions.id}
      offset 0
    )
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

/**
 * Run first in each batch's transaction: no sequential scans, so the open sessions
 * are read from table_sessions_one_open_per_table on any statistics. On statistics
 * taken while nearly every session was open (a young database whose history piled up
 * since the last analyze), Postgres judged that partial index no better than the
 * whole table and read every session ever closed (rows-read tested). The probes'
 * own tables are better served by their indexes anyway. Exported so a test can
 * EXPLAIN under it.
 */
export const keepToIndexes = (tx: Transaction) => tx.execute(sql`set local enable_seqscan = off`);

/** The next batch of sessions due to close, locked, skipping any another run or an order holds. */
export const idleSessions = (tx: Transaction, now: Date) =>
  tx
    .select({ restaurantId: tableSessions.restaurantId, id: tableSessions.id })
    .from(tableSessions)
    .where(due(now))
    .orderBy(asc(tableSessions.lastActivityAt))
    .limit(BATCH_SIZE)
    .for("no key update", { of: tableSessions, skipLocked: true });

/**
 * The close of these sessions, each still only if it is due. Exported so a test
 * can EXPLAIN it. The pairs must not be an index condition: when the pairs share a
 * restaurant, Postgres folds a plain `(restaurant_id, id) in (…)` into
 * `restaurant_id = …`, and on stale statistics served the close from an index on
 * that, reading every session the restaurant ever had (EXPLAIN-tested). The
 * `offset 0` keeps the pair check a filter on the rows the ids found.
 */
export const closing = (tx: Transaction, rows: readonly Due[], now: Date) =>
  tx
    .update(tableSessions)
    .set({ status: "closed", closedAt: now, closeReason: "idle_expiry" })
    .where(
      and(
        inArray(
          tableSessions.id,
          rows.map(({ id }) => id),
        ),
        sql`exists (
          select from (values ${sql.join(
            rows.map(({ restaurantId, id }) => sql`(${restaurantId}::uuid, ${id}::uuid)`),
            sql`, `,
          )}) as pair (restaurant_id, id)
          where pair.restaurant_id = ${tableSessions.restaurantId} and pair.id = ${tableSessions.id}
          offset 0
        )`,
        due(now),
      ),
    );

/** Closes these sessions, each still only if it is due. Returns how many closed. */
export async function closeSessions(tx: Transaction, rows: readonly Due[], now: Date) {
  if (rows.length === 0) return 0;
  const { rowCount } = await closing(tx, rows, now);
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
        await keepToIndexes(tx);
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
