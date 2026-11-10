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

export type TemplateName = "booking_confirmed";

/** One template message, ready for a sender: who, which template, and the values. */
export type TemplateMessage = {
  /** E.164, as bookings.guest_phone holds it. */
  to: string;
  template: TemplateName;
  language: typeof TEMPLATE_LANGUAGE;
  /** {{1}}, {{2}}, ... in order. */
  body: string[];
  /** The URL button's parameter: the manage page is /b/{manage_token}. */
  manageToken: string;
};

const templateText: Record<TemplateName, string> = {
  booking_confirmed:
    "Hi {{1}}, your table at {{2}} is confirmed for {{3}} people on {{4}} at {{5}}. " +
    "Need to cancel? Use the button below. This number doesn't receive replies — to reach the restaurant, call {{6}}.",
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

/** The message as the guest reads it, for the development console. */
export function renderText(message: TemplateMessage) {
  const text = templateText[message.template].replace(
    /\{\{(\d+)\}\}/g,
    (_, n: string) => message.body[Number(n) - 1] ?? "",
  );
  return `${text}\n[Manage booking] /b/${message.manageToken}`;
}
