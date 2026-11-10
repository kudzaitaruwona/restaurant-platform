import "server-only";
import { notifications } from "@/db/schema";
import type { TenantTransaction } from "@/lib/tenant/scope";

/** D-03 (settled 2026-11-11): one reminder, this long before the booking starts. */
export const REMINDER_LEAD_MS = 3 * 60 * 60_000;

/**
 * Queues the guest's WhatsApp messages for a new confirmed booking (spec 05,
 * scheduling): booking_confirmed, due at once, and booking_reminder, due at
 * starts_at - 3h, or not at all when that time has already passed (a booking made
 * less than 3 hours ahead). Both are written in the caller's transaction, so they
 * exist if and only if the booking does. The scheduled job sends it
 * (src/lib/cron/notifications.ts). Only for a guest who opted in and gave a
 * number (spec 05, data and privacy); anyone else gets nothing queued.
 *
 * Every path that creates a confirmed booking calls this: the guest's online
 * booking (src/lib/bookings.ts) and staff adding one (src/lib/booking-staff.ts).
 */
export async function queueBookingConfirmed(
  tx: TenantTransaction,
  booking: { restaurantId: string; id: string; guestPhone: string | null; whatsappOptIn: boolean; startsAt: Date },
  now: Date,
) {
  if (!booking.whatsappOptIn || !booking.guestPhone) return;
  const remindAt = new Date(booking.startsAt.getTime() - REMINDER_LEAD_MS);
  await tx.insert(notifications).values([
    { restaurantId: booking.restaurantId, bookingId: booking.id, kind: "booking_confirmed", scheduledFor: now },
    ...(remindAt.getTime() >= now.getTime()
      ? [{ restaurantId: booking.restaurantId, bookingId: booking.id, kind: "booking_reminder" as const, scheduledFor: remindAt }]
      : []),
  ]);
}

/**
 * Queues the guest's WhatsApp cancellation: one booking_cancelled row, due at once,
 * written in the transaction that cancelled the booking, so it exists if and only
 * if the cancel committed. Called once per booking, by the cancel that won the
 * status-guarded UPDATE (a repeat or a loser changes nothing and queues nothing).
 * Same opt-in and number rule as the confirmation. Wording, and the check that the
 * booking is still cancelled, are at send time (src/lib/cron/notifications.ts).
 *
 * Both cancel paths call this: the guest's (src/lib/bookings.ts) and staff's
 * (src/lib/booking-day.ts), which is also how a closure's bookings are cancelled.
 */
export async function queueBookingCancelled(
  tx: TenantTransaction,
  booking: { restaurantId: string; id: string; guestPhone: string | null; whatsappOptIn: boolean },
  now: Date,
) {
  if (!booking.whatsappOptIn || !booking.guestPhone) return;
  await tx.insert(notifications).values({
    restaurantId: booking.restaurantId,
    bookingId: booking.id,
    kind: "booking_cancelled",
    scheduledFor: now,
  });
}
