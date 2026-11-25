import { notFound } from "next/navigation";
import { formSaved } from "./form-response";
import type { WalkInBooking, WalkInOutcome } from "./walk-in";

/** The booking in the way, as the refusal lists it (ActionForm links it): name and party, no phone. */
const inTheWay = (booking: WalkInBooking) => ({
  id: booking.id,
  summary: `${booking.day}, ${booking.time} · ${booking.guestName} · ${booking.partySize} ${booking.partySize === 1 ? "guest" : "guests"}`,
  href: booking.href,
});

/**
 * Answers Seat walk-in. The 409s say what to do instead; the under-30-minutes one
 * is spec 04's prompt, with the time on the restaurant's clock.
 */
export function walkInResponse(outcome: WalkInOutcome, request: Request) {
  const refuse = (error: string, booking?: WalkInBooking) =>
    Response.json(
      { error, ...(booking ? { bookings: [inTheWay(booking)] } : {}) },
      { status: 409 },
    );
  switch (outcome.outcome) {
    case "not_found":
      notFound();
    case "table_archived":
      return refuse(`Table ${outcome.table} is archived. Seat the walk-in elsewhere.`);
    case "table_occupied":
      return refuse(
        outcome.resetting
          ? `Table ${outcome.table} is being reset until ${outcome.freeAt}. Seat the walk-in elsewhere.`
          : `Table ${outcome.table} is in use until ${outcome.freeAt}. Seat the walk-in elsewhere.`,
        outcome.booking,
      );
    case "booking_soon":
      return refuse(
        `Table ${outcome.table} has a booking at ${outcome.at} — move that booking, or seat the walk-in elsewhere`,
        outcome.booking,
      );
    case "table_taken":
      return refuse(
        "That table was just taken by another booking. Reload to see the latest, or seat the walk-in elsewhere.",
      );
    case "seated":
      return formSaved(request, "/dashboard/bookings");
  }
}
