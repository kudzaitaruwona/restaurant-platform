import "server-only";
import { and, asc, eq, gte, lt, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { notFound } from "next/navigation";
import { z } from "zod";
import { bookings, diningTables, notifications, restaurants, servicePeriods } from "@/db/schema";
import {
  addDays,
  dateLabel,
  instantOf,
  localToday,
  localTime,
  weekdayOf,
} from "@/lib/booking-engine";
import { chooseDay, type DayRow, groupByPeriod } from "@/lib/booking-day-view";
import { finishedTimes } from "@/lib/booking-finish";
import { queueBookingCancelled } from "@/lib/notifications";
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
export { HOLD_CAP_MINUTES } from "@/lib/booking-finish";

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
        source: bookings.source,
        confirmationStatus: notifications.status,
      })
      .from(bookings)
      .innerJoin(
        diningTables,
        and(
          eq(diningTables.restaurantId, bookings.restaurantId),
          eq(diningTables.id, bookings.tableId),
        ),
      )
      // The booking's WhatsApp confirmation, if one was queued (spec 05): at most
      // one, by UNIQUE (booking_id, kind).
      .leftJoin(
        notifications,
        and(
          eq(notifications.restaurantId, bookings.restaurantId),
          eq(notifications.bookingId, bookings.id),
          eq(notifications.kind, "booking_confirmed"),
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
    const dayRows: DayRow[] = rows.map(({ startsAt, confirmationStatus, ...row }) => ({
      ...row,
      time: localTime(startsAt, timezone),
      late: row.status === "confirmed" && startsAt.getTime() <= lateBefore,
      // Staff should call a guest still to arrive; once seated, they are here.
      confirmationFailed: row.status === "confirmed" && confirmationStatus === "failed",
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

/** The booking a transition changed, with what a follow-on write may need (never shown to anyone). */
type ChangedBooking = { id: string; guestPhone: string | null; whatsappOptIn: boolean };

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
  after: (tx: TenantTransaction, changed: ChangedBooking) => Promise<void>,
): Promise<ActionOutcome> {
  try {
    return await withTenant(actor, async (tx) => {
      const where = and(eq(bookings.restaurantId, actor.restaurantId), eq(bookings.id, bookingId));
      const changed = await tx
        .update(bookings)
        .set(set)
        .where(and(where, eq(bookings.status, from)))
        .returning({
          id: bookings.id,
          guestPhone: bookings.guestPhone,
          whatsappOptIn: bookings.whatsappOptIn,
        });
      if (changed.length === 0) {
        const [current] = await tx.select({ status: bookings.status }).from(bookings).where(where);
        return current
          ? { outcome: "wrong_status", status: current.status }
          : { outcome: "not_found" };
      }
      await after(tx, changed[0]);
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
 * table (Finish ends that), and the rest are over. Queues the guest's cancellation
 * message in the same transaction (spec 05), whoever the actor, so closures, which
 * make staff cancel each booking in the way, send it too.
 */
export const cancelBooking = (actor: Actor, bookingId: string) =>
  transition(
    actor,
    bookingId,
    "confirmed",
    { status: "cancelled", cancelledBy: "staff", cancelledAt: sql`now()` },
    async (tx, booking) => {
      await recordAudit(tx, actor, {
        action: "booking.cancel",
        entityType: "booking",
        entityId: bookingId,
        details: { cancelledBy: "staff" },
      });
      await queueBookingCancelled(tx, { restaurantId: actor.restaurantId, ...booking }, new Date());
    },
  );

/**
 * Finish: `seated → completed`, with the times finishedTimes gives (spec 04): the
 * table frees after the reset buffer, within the 960-minute cap and before the
 * next booking on it. A booking landing in that gap at the same instant is
 * refused by the exclusion constraint, and answered "table_taken".
 * `now` is a parameter so a test can finish a booking at a chosen instant.
 */
export function finishBooking(actor: Actor, bookingId: string, now = new Date()) {
  return transition(
    actor,
    bookingId,
    "seated",
    { status: "completed", ...finishedTimes(now) },
    audited(actor, bookingId, "booking.finish"),
  );
}
