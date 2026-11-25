import "server-only";
import { and, eq, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { bookingRateLimit } from "@/db/schema";
import { SUBMISSIONS_PER_WINDOW } from "@/lib/booking-limits";

/**
 * The count behind the guest's rate limit (spec 04, proposed). It lives with the
 * tenant seam because it is the one table the public path writes with no tenant:
 * it belongs to no restaurant, and its RLS policy shows it only outside one.
 */
const WINDOW = "10 minutes";
const WINDOW_SECONDS = 600;

/**
 * Whether this visitor may submit again, and if not, for how long they are
 * refused. Every submission spends one, up front, in a single statement, so a
 * burst of parallel posts can't all pass a check that hasn't been written yet. A
 * fixed window, from the first submission: refused ones don't extend it (the count
 * stops at one past the limit), and a visitor at the edge can have up to twice the
 * limit across two windows. In Postgres because memory is per-instance on Vercel.
 */
export async function spendSubmission(key: string) {
  const table = bookingRateLimit;
  const windowIsOver = sql`${table.windowStartedAt} <= now() - ${WINDOW}::interval`;
  const [{ attempts, window, retryAfter }] = await getDb()
    .insert(table)
    .values({ key, attempts: 1, windowStartedAt: sql`now()` })
    .onConflictDoUpdate({
      target: table.key,
      set: {
        attempts: sql`case when ${windowIsOver} then 1
          else least(${table.attempts} + 1, ${SUBMISSIONS_PER_WINDOW + 1}) end`,
        windowStartedAt: sql`case when ${windowIsOver} then now() else ${table.windowStartedAt} end`,
      },
    })
    .returning({
      attempts: table.attempts,
      window: sql<string>`${table.windowStartedAt}::text`,
      retryAfter: sql<number>`ceil(extract(epoch from ${table.windowStartedAt} + ${WINDOW}::interval - now()))::int`,
    });
  // Rarely, and never at the guest's expense: rows past their window are dead.
  if (Math.random() < 0.02) void pruneSubmissions().catch(() => {});
  return attempts <= SUBMISSIONS_PER_WINDOW
    ? { allowed: true as const, giveBack: () => giveBack(key, window) }
    : { allowed: false as const, retryAfterSeconds: Math.min(Math.max(retryAfter, 1), WINDOW_SECONDS) };
}

/**
 * Takes back one counted submission: it was a retry of a booking already made, and
 * that one counted (#134). Only in the window it was counted in, and only for one the
 * limit allowed: a refused one was never counted, whatever the count stopped at.
 */
async function giveBack(key: string, window: string) {
  const table = bookingRateLimit;
  await getDb()
    .update(table)
    .set({ attempts: sql`least(${table.attempts}, ${SUBMISSIONS_PER_WINDOW}) - 1` })
    .where(and(eq(table.key, key), sql`${table.windowStartedAt} = ${window}::timestamptz`));
}

/** Rows whose window is long over. They stay until a visitor returns, so they are swept here. */
export function pruneSubmissions() {
  return getDb()
    .delete(bookingRateLimit)
    .where(lt(bookingRateLimit.windowStartedAt, sql`now() - interval '1 hour'`));
}
