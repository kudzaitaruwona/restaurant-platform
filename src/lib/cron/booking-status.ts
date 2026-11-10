import "server-only";
import { and, asc, eq, lte, notInArray, sql, type SQL } from "drizzle-orm";
import type { Database } from "@/db/client";
import { bookings } from "@/db/schema";
import { finishedTimes } from "@/lib/booking-finish";

/**
 * Spec 04's automatic status changes, run by the scheduled job (S-35) as
 * app_system, across every restaurant:
 *  - a `confirmed` booking still not seated at its `ends_at` becomes `no_show`;
 *  - a `seated` booking past its `hold_ends_at` becomes `completed`, with the
 *    times staff's Finish would give it at that moment (finishedTimes).
 * Late (confirmed and 30 minutes past the start) is only the day view's
 * highlight, and nothing here touches it.
 *
 * Safe to overlap and to repeat, because Vercel can deliver one run twice and a
 * slow run can meet the next. Each batch locks the rows it takes with FOR UPDATE
 * SKIP LOCKED, so two runs never take the same booking, and a booking staff are
 * changing at that moment is left for the next run rather than waited on. The
 * UPDATE still says `WHERE status = expected`, as staff's actions do, and names
 * each booking by its restaurant_id as well as its id (spec 01, System routes).
 * Each change is audited as the system's (actor_type = system, no actor_id) in
 * the same transaction, so a booking changed is a booking recorded.
 *
 * `now` is a parameter so a test can pick the moment; the route passes the
 * server's clock.
 */

type Due = { restaurantId: string; id: string };

/** Rows per transaction, and transactions per run, for each rule. */
const BATCH_SIZE = 200;
const MAX_BATCHES = 25;

export async function markNoShows(db: Database, now: Date): Promise<number> {
  const due = and(eq(bookings.status, "confirmed"), lte(bookings.endsAt, now))!;
  let marked = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const { taken, changed } = await db.transaction(async (tx) => {
      const rows = await takeDue(tx, due, bookings.endsAt);
      if (rows.length === 0) return { taken: 0, changed: [] };
      const changed = await tx
        .update(bookings)
        .set({ status: "no_show" })
        .where(and(isOneOf(rows), due))
        .returning({ restaurantId: bookings.restaurantId, id: bookings.id });
      await recordSystemAction(tx, changed, "booking.no_show");
      return { taken: rows.length, changed };
    });
    marked += changed.length;
    if (taken < BATCH_SIZE) break;
  }
  return marked;
}

export async function completeOverdueSittings(db: Database, now: Date): Promise<number> {
  const due = and(eq(bookings.status, "seated"), lte(bookings.holdEndsAt, now))!;
  // A booking whose new hold met another landing in the same instant: left
  // seated for the next run, and not taken again by this one.
  const refused: string[] = [];
  let completed = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const pending = refused.length > 0 ? and(due, notInArray(bookings.id, refused))! : due;
    const { taken, changed } = await db.transaction(async (tx) => {
      const rows = await takeDue(tx, pending, bookings.holdEndsAt);
      const changed: Due[] = [];
      // One at a time, each in a savepoint: a stretched hold can meet the
      // exclusion constraint, and that must cost this booking, not the batch.
      for (const row of rows) {
        try {
          const [done] = await tx.transaction((savepoint) =>
            savepoint
              .update(bookings)
              .set({ status: "completed", ...finishedTimes(now) })
              .where(and(isOneOf([row]), due))
              .returning({ restaurantId: bookings.restaurantId, id: bookings.id }),
          );
          if (done) changed.push(done);
        } catch (error) {
          if (!isOverlap(error)) throw error;
          refused.push(row.id);
        }
      }
      await recordSystemAction(tx, changed, "booking.finish");
      return { taken: rows.length, changed };
    });
    completed += changed.length;
    if (taken < BATCH_SIZE) break;
  }
  return completed;
}

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** The next batch of due bookings, locked, skipping any another run or staff holds. */
function takeDue(tx: Transaction, due: SQL, order: typeof bookings.endsAt | typeof bookings.holdEndsAt) {
  return tx
    .select({ restaurantId: bookings.restaurantId, id: bookings.id })
    .from(bookings)
    .where(due)
    .orderBy(asc(order))
    .limit(BATCH_SIZE)
    .for("update", { skipLocked: true });
}

/** These bookings and no others, each by its restaurant as well as its id. */
const isOneOf = (rows: readonly Due[]) =>
  sql`(${bookings.restaurantId}, ${bookings.id}) in (${sql.join(
    rows.map(({ restaurantId, id }) => sql`(${restaurantId}::uuid, ${id}::uuid)`),
    sql`, `,
  )})`;

/**
 * The system's audit entries. Written in SQL naming only the columns app_system
 * may insert, so the id and the time are Postgres's own.
 */
async function recordSystemAction(tx: Transaction, rows: readonly Due[], action: string) {
  if (rows.length === 0) return;
  await tx.execute(sql`
    insert into audit_log (restaurant_id, actor_type, actor_id, action, entity_type, entity_id)
    values ${sql.join(
      rows.map(
        ({ restaurantId, id }) =>
          sql`(${restaurantId}::uuid, 'system', null, ${action}, 'booking', ${id}::uuid)`,
      ),
      sql`, `,
    )}
  `);
}

function isOverlap(error: unknown) {
  const cause = (error as { cause?: { code?: string; constraint?: string } } | null)?.cause;
  return cause?.code === "23P01" && cause.constraint === "bookings_no_overlap";
}
