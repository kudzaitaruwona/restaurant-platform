import { dateLabel, localTime, localToday } from "@/lib/booking-engine";

/**
 * The WhatsApp template messages (spec 05), in one place: which template, in
 * which language, and what fills each placeholder. The wording itself lives in
 * Meta's approved template; `templateText` is a copy of it for the development
 * console and for tests, so a wording change (#11) is an edit here and a
 * resubmission to Meta.
 */

/** Every template is submitted to Meta in this one language. */
export const TEMPLATE_LANGUAGE = "en";

export type TemplateName = "booking_confirmed" | "booking_reminder" | "booking_cancelled";

/** One template message, ready for a sender: who, which template, and the values. */
export type TemplateMessage = {
  /** E.164, as bookings.guest_phone holds it. */
  to: string;
  template: TemplateName;
  language: typeof TEMPLATE_LANGUAGE;
  /** {{1}}, {{2}}, ... in order. */
  body: string[];
  /** The URL button's parameter: the manage page is /b/{manage_token}. Absent for a template with no button. */
  manageToken?: string;
};

const templateText: Record<TemplateName, string> = {
  booking_confirmed:
    "Hi {{1}}, your table at {{2}} is confirmed for {{3}} people on {{4}} at {{5}}. " +
    "Need to cancel? Use the button below. This number doesn't receive replies — to reach the restaurant, call {{6}}.",
  booking_reminder:
    "Hi {{1}}, a reminder of your booking at {{2}} on {{3}} at {{4}} for {{5}} people. " +
    "Can't make it? Please cancel so someone else can have the table.",
  booking_cancelled: "Hi {{1}}, your booking at {{2}} on {{3}} at {{4}} has been cancelled. {{5}}",
};

export type ConfirmedBooking = {
  guestName: string;
  guestPhone: string;
  restaurantName: string;
  restaurantPhone: string;
  partySize: number;
  startsAt: Date;
  /** restaurants.timezone: the date and time are the restaurant's, never the server's. */
  timezone: string;
  manageToken: string;
};

/** "Fri 6 Nov" and "19:30" on the restaurant's clock, as the guest's confirmation page shows them. */
function whenOf(startsAt: Date, timezone: string) {
  return [dateLabel(localToday(startsAt, timezone)), localTime(startsAt, timezone)];
}

/** booking_confirmed: guest, restaurant, party size, date, time, restaurant phone. */
export function bookingConfirmed(booking: ConfirmedBooking): TemplateMessage {
  return {
    to: booking.guestPhone,
    template: "booking_confirmed",
    language: TEMPLATE_LANGUAGE,
    body: [
      booking.guestName,
      booking.restaurantName,
      String(booking.partySize),
      ...whenOf(booking.startsAt, booking.timezone),
      booking.restaurantPhone,
    ],
    manageToken: booking.manageToken,
  };
}

/** booking_reminder: guest, restaurant, date, time, party size. Names the date, never "today" (spec 05). */
export function bookingReminder(booking: ConfirmedBooking): TemplateMessage {
  return {
    to: booking.guestPhone,
    template: "booking_reminder",
    language: TEMPLATE_LANGUAGE,
    body: [
      booking.guestName,
      booking.restaurantName,
      ...whenOf(booking.startsAt, booking.timezone),
      String(booking.partySize),
    ],
    manageToken: booking.manageToken,
  };
}

export type CancelledBooking = Omit<ConfirmedBooking, "manageToken" | "partySize" | "restaurantPhone"> & {
  /** Null when the restaurant has no contact phone. */
  restaurantPhone: string | null;
  cancelledBy: "guest" | "staff" | null;
};

/**
 * booking_cancelled: guest, restaurant, date, time, and {{5}}: a goodbye when the
 * guest cancelled, the restaurant's contact line when staff did (a closure's
 * cancellations are staff's). No manage link: a cancelled booking has nothing to manage.
 */
export function bookingCancelled(booking: CancelledBooking): TemplateMessage {
  const line =
    booking.cancelledBy === "guest"
      ? "We hope to see you another time."
      : booking.restaurantPhone
        ? `If you have any questions, please call the restaurant on ${booking.restaurantPhone}.`
        : "If you have any questions, please contact the restaurant.";
  return {
    to: booking.guestPhone,
    template: "booking_cancelled",
    language: TEMPLATE_LANGUAGE,
    body: [booking.guestName, booking.restaurantName, ...whenOf(booking.startsAt, booking.timezone), line],
  };
}

/** The message as the guest reads it, for the development console. */
export function renderText(message: TemplateMessage) {
  const text = templateText[message.template].replace(
    /\{\{(\d+)\}\}/g,
    (_, n: string) => message.body[Number(n) - 1] ?? "",
  );
  return message.manageToken ? `${text}\n[Manage booking] /b/${message.manageToken}` : text;
}
