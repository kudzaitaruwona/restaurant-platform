import "server-only";
import { notifications } from "@/db/schema";
import type { TenantTransaction } from "@/lib/tenant/scope";

/**
 * Queues the guest's WhatsApp confirmation (spec 05, scheduling): one
 * booking_confirmed row, due at once, written in the caller's transaction, so it
 * exists if and only if the booking does. The scheduled job sends it
 * (src/lib/cron/notifications.ts). Only for a guest who opted in and gave a
 * number (spec 05, data and privacy); anyone else gets nothing queued.
 *
 * Every path that creates a confirmed booking calls this: the guest's online
 * booking (src/lib/bookings.ts) and staff adding one (src/lib/booking-staff.ts).
 */
export async function queueBookingConfirmed(
  tx: TenantTransaction,
  booking: { restaurantId: string; id: string; guestPhone: string | null; whatsappOptIn: boolean },
  now: Date,
) {
  if (!booking.whatsappOptIn || !booking.guestPhone) return;
  await tx.insert(notifications).values({
    restaurantId: booking.restaurantId,
    bookingId: booking.id,
    kind: "booking_confirmed",
    scheduledFor: now,
  });
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
