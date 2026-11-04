import { notFound } from "next/navigation";
import { formSaved } from "./form-response";
import type { WalkInOutcome } from "./walk-in";

/**
 * Answers Seat walk-in. The 409s say what to do instead; the under-30-minutes one
 * is spec 04's prompt, with the time on the restaurant's clock.
 */
export function walkInResponse(outcome: WalkInOutcome, request: Request) {
  const refuse = (error: string) => Response.json({ error }, { status: 409 });
  switch (outcome.outcome) {
    case "not_found":
      notFound();
    case "table_archived":
      return refuse(`Table ${outcome.table} is archived. Seat the walk-in elsewhere.`);
    case "table_occupied":
      return refuse(
        `Table ${outcome.table} is in use until ${outcome.freeAt}. Seat the walk-in elsewhere.`,
      );
    case "booking_soon":
      return refuse(
        `Table ${outcome.table} has a booking at ${outcome.at} — move that booking, or seat the walk-in elsewhere`,
      );
    case "table_taken":
      return refuse(
        "That table was just taken by another booking. Reload to see the latest, or seat the walk-in elsewhere.",
      );
    case "seated":
      return formSaved(request, "/dashboard/bookings");
  }
}
