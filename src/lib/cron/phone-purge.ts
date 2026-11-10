import "server-only";
import { and, asc, isNotNull, lte, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { bookings, restaurants } from "@/db/schema";

/**
 * D-06 (proposed), run by the scheduled job (S-35) as app_system: a booking's
 * phone number is nulled 30 days after the booking date. The name and the
 * outcome stay, so the no-show stats (spec 04) keep working, and so does
 * everything else on the row. Only `guest_phone` is written.
 *
 * "The booking date" is the booking's `starts_at` as a calendar date on the
 * restaurant's own clock (`restaurants.timezone`, never UTC and never the
 * server's). The number goes at the local midnight that starts day
 * booking_date + 30, so a booking on 2 May loses its number at 00:00 on 1 June,
 * local time, and not a minute before. The date arithmetic is done in Postgres,
 * on the local date, so a month that is 30 or 31 days long and a clock change
 * between the two don't matter: the day is the unit, not 30 x 24 hours.
 *
 * It goes by the booking, whatever its status: a cancelled booking's number is
 * as personal as a completed one's, and nothing needs it after the date.
 * (Notifications need it, but a booking this old has nothing left to send.)
 *
 * Idempotent and safe to overlap, like the other tasks: only rows still holding
 * a number are taken, in batches locked with FOR UPDATE SKIP LOCKED, and the
 * UPDATE names each row by (restaurant_id, id) and repeats `guest_phone is not
 * null`, so a repeat or an overlapping run changes nothing a second time.
 *
 * `now` is a parameter so a test can pick the moment.
 */

const BATCH_SIZE = 200;
const MAX_BATCHES = 25;

/** Local midnight starting day booking_date + 30, in the restaurant's zone. */
const purgeFrom = sql`(((${bookings.startsAt} at time zone ${restaurants.timezone})::date + 30)::timestamp at time zone ${restaurants.timezone})`;

export async function purgeGuestPhones(db: Database, now: Date): Promise<number> {
  // A booking this recent can't be due in any zone: the purge moment is at least
  // 29 days after the booking's own day ends, less a clock change, so 28 days
  // is safe. It lets the partial index on starts_at do the narrowing.
  const recent = new Date(now.getTime() - 28 * 86_400_000);
  const due = and(
    isNotNull(bookings.guestPhone),
    lte(bookings.startsAt, recent),
    sql`${purgeFrom} <= ${now.toISOString()}::timestamptz`,
  )!;
  let purged = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const { taken, changed } = await db.transaction(async (tx) => {
      const rows = await tx
        .select({ restaurantId: bookings.restaurantId, id: bookings.id })
        .from(bookings)
        .innerJoin(restaurants, sql`${restaurants.id} = ${bookings.restaurantId}`)
        .where(due)
        .orderBy(asc(bookings.startsAt))
        .limit(BATCH_SIZE)
        .for("update", { of: bookings, skipLocked: true });
      if (rows.length === 0) return { taken: 0, changed: 0 };
      const { rowCount } = await tx
        .update(bookings)
        .set({ guestPhone: null })
        .where(
          and(
            isNotNull(bookings.guestPhone),
            sql`(${bookings.restaurantId}, ${bookings.id}) in (${sql.join(
              rows.map(({ restaurantId, id }) => sql`(${restaurantId}::uuid, ${id}::uuid)`),
              sql`, `,
            )})`,
          ),
        );
      return { taken: rows.length, changed: rowCount ?? 0 };
    });
    purged += changed;
    if (taken < BATCH_SIZE) break;
  }
  return purged;
}
