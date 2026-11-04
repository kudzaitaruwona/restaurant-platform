import "server-only";
import { and, asc, eq, gte, lt, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { notFound } from "next/navigation";
import { z } from "zod";
import { bookings, diningTables, restaurants, servicePeriods } from "@/db/schema";
import {
  addDays,
  blockingStatuses,
  dateLabel,
  instantOf,
  localToday,
  localTime,
  weekdayOf,
} from "@/lib/booking-engine";
import { chooseDay, type DayRow, groupByPeriod } from "@/lib/booking-day-view";
import { recordAdminAction, recordAudit } from "@/lib/tenant/audit";
import { type TenantContext, type TenantTransaction, withTenant } from "@/lib/tenant/scope";

/**
 * The staff day view and its actions (spec 04). Owners and staff both use it
 * (S-26), so nothing here checks the role; the restaurant always comes from the
 * context, never from a request.
 */

type Tenant = Pick<TenantContext, "restaurantId">;
type Actor = Pick<TenantContext, "restaurantId" | "staffId" | "platformAdminId">;

const MINUTE = 60_000;
/** How long after its start a confirmed booking shows as Late (spec 04). */
export const LATE_AFTER_MINUTES = 30;
/** bookings_hold_capped's limit (migration 0015), in minutes. */
export const HOLD_CAP_MINUTES = 960;

// --- reading a day ----------------------------------------------------------

/**
 * One day on the restaurant's calendar: three reads however many bookings the day
 * has (the restaurant's zone, the weekday's periods, the bookings with their
 * tables), grouped in memory. `rawDate` is the query string's, so it's checked.
 */
export function getDayView(tenant: Tenant, rawDate: string | string[] | undefined, now = new Date()) {
  return withTenant(tenant, async (tx) => {
    const [{ timezone }] = await tx
      .select({ timezone: restaurants.timezone })
      .from(restaurants)
      .where(eq(restaurants.id, tenant.restaurantId));
    const today = localToday(now, timezone);
    const { date, refused } = chooseDay(rawDate, today);

    const periods = await tx
      .select({
        name: servicePeriods.name,
        opensAt: servicePeriods.opensAt,
        closesAt: servicePeriods.closesAt,
      })
      .from(servicePeriods)
      .where(
        and(
          eq(servicePeriods.restaurantId, tenant.restaurantId),
          eq(servicePeriods.weekday, weekdayOf(date)),
        ),
      );

    const rows = await tx
      .select({
        id: bookings.id,
        startsAt: bookings.startsAt,
        guestName: bookings.guestName,
        partySize: bookings.partySize,
        table: diningTables.label,
        status: bookings.status,
        note: bookings.guestNote,
        phone: bookings.guestPhone,
      })
      .from(bookings)
      .innerJoin(
        diningTables,
        and(
          eq(diningTables.restaurantId, bookings.restaurantId),
          eq(diningTables.id, bookings.tableId),
        ),
      )
      .where(
        and(
          eq(bookings.restaurantId, tenant.restaurantId),
          gte(bookings.startsAt, instantOf(date, "00:00", timezone)),
          lt(bookings.startsAt, instantOf(addDays(date, 1), "00:00", timezone)),
        ),
      )
      .orderBy(asc(bookings.startsAt), asc(diningTables.label));

    const lateBefore = now.getTime() - LATE_AFTER_MINUTES * MINUTE;
    const dayRows: DayRow[] = rows.map(({ startsAt, ...row }) => ({
      ...row,
      time: localTime(startsAt, timezone),
      late: row.status === "confirmed" && startsAt.getTime() <= lateBefore,
    }));

    return {
      date,
      dateLabel: dateLabel(date),
      isToday: date === today,
      refused,
      previous: addDays(date, -1),
      next: addDays(date, 1),
      today,
      groups: groupByPeriod(periods, dayRows),
    };
  });
}

// --- the actions ------------------------------------------------------------

type BookingStatus = (typeof bookings.$inferSelect)["status"];

export type ActionOutcome =
  | { outcome: "done" }
  | { outcome: "not_found" }
  /** Someone else got there first, or it was never in a state this applies to. */
  | { outcome: "wrong_status"; status: BookingStatus }
  /** Finish only: a booking landed on the table in the instant before it was freed. */
  | { outcome: "table_taken" };

/** The id in a booking route. A malformed one is a 404, like an unknown one. */
export async function bookingIdFrom(params: Promise<{ bookingId: string }>) {
  const parsed = z.uuid().safeParse((await params).bookingId);
  if (!parsed.success) notFound();
  return parsed.data;
}

/**
 * Moves a booking out of `from`, in the one statement: `WHERE status = from` is
 * what makes two staff tapping at once, or a tap racing a guest's cancel, one
 * winner. The loser's UPDATE waits on the row, then finds it no longer matches and
 * changes nothing. Whether it was missing or only in another state is a read after,
 * for the message.
 *
 * `after` writes whatever must commit with the change, in the same transaction.
 */
async function transition(
  actor: Actor,
  bookingId: string,
  from: BookingStatus,
  set: PgUpdateSetSource<typeof bookings>,
  after: (tx: TenantTransaction) => Promise<void>,
): Promise<ActionOutcome> {
  try {
    return await withTenant(actor, async (tx) => {
      const where = and(eq(bookings.restaurantId, actor.restaurantId), eq(bookings.id, bookingId));
      const changed = await tx
        .update(bookings)
        .set(set)
        .where(and(where, eq(bookings.status, from)))
        .returning({ id: bookings.id });
      if (changed.length === 0) {
        const [current] = await tx.select({ status: bookings.status }).from(bookings).where(where);
        return current
          ? { outcome: "wrong_status", status: current.status }
          : { outcome: "not_found" };
      }
      await after(tx);
      return { outcome: "done" };
    });
  } catch (error) {
    // The exclusion constraint, reached only by Finish stretching a hold: see there.
    const cause = (error as { cause?: { code?: string; constraint?: string } } | null)?.cause;
    if (cause?.code === "23P01" && cause.constraint === "bookings_no_overlap") {
      return { outcome: "table_taken" };
    }
    // A Drizzle error's message quotes the statement's parameters.
    throw new Error(`changing a booking failed: ${cause?.code ?? "unknown"}`);
  }
}

/**
 * Spec 01's audit list covers cancellations and moves by staff, so a cancel is
 * recorded for whoever acts, and the other actions only for a platform admin, who
 * is audited for everything inside a tenant (S-28). No guest details go in.
 */
const audited = (actor: Actor, bookingId: string, action: string) =>
  (tx: TenantTransaction) =>
    recordAdminAction(tx, actor, { action, entityType: "booking", entityId: bookingId });

export const seatBooking = (actor: Actor, bookingId: string) =>
  transition(actor, bookingId, "confirmed", { status: "seated" }, audited(actor, bookingId, "booking.seat"));

/**
 * No-show frees the table because the exclusion constraint only counts confirmed,
 * seated and completed bookings. Nothing leads out of no_show, so the table can't
 * be claimed back by a booking coming back to life under someone else's.
 */
export const markNoShow = (actor: Actor, bookingId: string) =>
  transition(actor, bookingId, "confirmed", { status: "no_show" }, audited(actor, bookingId, "booking.no_show"));

/**
 * Cancel *(proposed)* applies to a confirmed booking only: a seated party is at the
 * table (Finish ends that), and the rest are over. Queues a cancellation message
 * once spec 05 lands.
 */
export const cancelBooking = (actor: Actor, bookingId: string) =>
  transition(
    actor,
    bookingId,
    "confirmed",
    { status: "cancelled", cancelledBy: "staff", cancelledAt: sql`now()` },
    (tx) =>
      recordAudit(tx, actor, {
        action: "booking.cancel",
        entityType: "booking",
        entityId: bookingId,
        details: { cancelledBy: "staff" },
      }),
  );

/**
 * Finish: `seated → completed`, with ends_at = greatest(starts_at + 1 minute, now)
 * and hold_ends_at = ends_at + the buffer, so the table frees after the reset
 * buffer, not at the original end (spec 04). Three limits keep that a legal row,
 * and say what gives way *(proposed)*:
 *  - bookings_hold_capped: hold_ends_at - starts_at stays within 960 minutes. The
 *    buffer gives way first, then ends_at, so a booking finished the next morning
 *    still finishes, with the time it really ended wherever the cap allows.
 *  - the exclusion constraint: finishing only ever releases a table, except when
 *    the party stayed past its hold. Then the hold would stretch into whatever is
 *    booked next on that table, so it stops at that booking's start, and ends_at
 *    with it. A booking landing in that gap at the same instant is refused by the
 *    constraint, and answered "table_taken".
 *  - ends_at <= hold_ends_at, which bookings_times_ordered needs.
 * `now` is a parameter so a test can finish a booking at a chosen instant.
 */
export function finishBooking(actor: Actor, bookingId: string, now = new Date()) {
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
    where other.table_id = ${bookings.tableId} and other.id <> ${bookings.id}
      and other.starts_at >= ${bookings.startsAt}
      and other.status in (${blocking}))`;
  const hold = sql`least(${reached} + ${buffer}, ${cap}, coalesce(${nextBooking}, 'infinity'::timestamptz))`;

  return transition(
    actor,
    bookingId,
    "seated",
    { status: "completed", endsAt: sql`least(${reached}, ${hold})`, holdEndsAt: hold },
    audited(actor, bookingId, "booking.finish"),
  );
}
