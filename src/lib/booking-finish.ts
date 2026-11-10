import { sql } from "drizzle-orm";
import { bookings } from "@/db/schema";
import { blockingStatuses } from "@/lib/booking-engine";

/** bookings_hold_capped's limit (migration 0022), in minutes. */
export const HOLD_CAP_MINUTES = 960;

/**
 * The times a seated booking finishes with at `now` (spec 04, Finish), as SQL
 * over the row being updated: staff's Finish and the scheduled job's automatic
 * completion both set these, so the two can't disagree. ends_at =
 * greatest(starts_at + 1 minute, now) and hold_ends_at = ends_at + the buffer, so
 * the table frees after the reset buffer, not at the original end. Three limits
 * keep that a legal row, and say what gives way *(proposed)*:
 *  - bookings_hold_capped: hold_ends_at - starts_at stays within 960 minutes. The
 *    buffer gives way first, then ends_at, so a booking finished the next morning
 *    still finishes, with the time it really ended wherever the cap allows.
 *  - the exclusion constraint: finishing only ever releases a table, except when
 *    the party stayed past its hold. Then the hold would stretch into whatever is
 *    booked next on that table, so it stops at that booking's start, and ends_at
 *    with it. A booking landing in that gap at the same instant is refused by the
 *    constraint.
 *  - ends_at <= hold_ends_at, which bookings_times_ordered needs.
 * Every read names the booking's own restaurant, because the job runs these
 * outside RLS.
 */
export function finishedTimes(now: Date) {
  const at = sql`${now.toISOString()}::timestamptz`;
  const starts = sql`${bookings.startsAt}`;
  const cap = sql`${starts} + ${HOLD_CAP_MINUTES} * interval '1 minute'`;
  const blocking = sql.join(
    blockingStatuses.map((status) => sql`${status}`),
    sql`, `,
  );
  const reached = sql`least(greatest(${starts} + interval '1 minute', ${at}), ${cap})`;
  const buffer = sql`(select bs.buffer_minutes from booking_settings bs
    where bs.restaurant_id = ${bookings.restaurantId}) * interval '1 minute'`;
  const nextBooking = sql`(select min(other.starts_at) from bookings other
    where other.restaurant_id = ${bookings.restaurantId}
      and other.table_id = ${bookings.tableId} and other.id <> ${bookings.id}
      and other.starts_at >= ${bookings.startsAt}
      and other.status in (${blocking}))`;
  const hold = sql`least(${reached} + ${buffer}, ${cap}, coalesce(${nextBooking}, 'infinity'::timestamptz))`;
  return { endsAt: sql`least(${reached}, ${hold})`, holdEndsAt: hold };
}
