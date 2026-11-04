import { notFound } from "next/navigation";
import type { AddOutcome, MoveOutcome } from "./booking-staff";
import { formSaved } from "./form-response";

const statusWords = {
  confirmed: "confirmed",
  seated: "seated",
  completed: "finished",
  cancelled: "cancelled",
  no_show: "marked as a no-show",
} as const;

const refuse = (error: string, status: number) => Response.json({ error }, { status });

/** Answers the add-booking form. A refusal says what to change, never a 500. */
export function addBookingResponse(outcome: AddOutcome, request: Request) {
  switch (outcome.outcome) {
    case "table_not_found":
      notFound();
    case "date_unavailable":
      return refuse("That date can't be booked. Choose today or a later date within the booking window.", 409);
    case "time_unavailable":
      return refuse("The restaurant takes no bookings at that time on that day, or it has passed.", 409);
    case "table_archived":
      return refuse("That table is no longer in use. Choose another.", 409);
    case "too_small":
      return refuse(`That table seats ${outcome.capacity}, fewer than the party. Choose a bigger one.`, 409);
    case "no_fit":
      return refuse("No table seats a party that size.", 409);
    case "taken":
      return refuse("No table is free then, or that one was just taken. Choose another time or table.", 409);
    case "hold_too_long":
      return refuse("That booking would hold the table for too long. Check the sitting length in the settings.", 409);
    case "added":
      return formSaved(request, `/dashboard/bookings?date=${outcome.date}`);
  }
}

/** Answers Move table. A 409 says what the booking or table is now. */
export function moveBookingResponse(outcome: MoveOutcome, request: Request) {
  switch (outcome.outcome) {
    case "not_found":
    case "table_not_found":
      notFound();
    case "wrong_status":
      return refuse(
        `Move didn't apply: this booking is already ${statusWords[outcome.status]}. Only a confirmed booking can move. Reload to see the latest.`,
        409,
      );
    case "same_table":
      return refuse("The booking is already at that table.", 409);
    case "table_archived":
      return refuse("That table is no longer in use. Choose another.", 409);
    case "too_small":
      return refuse(`That table seats ${outcome.capacity}, fewer than the party of ${outcome.party}.`, 409);
    case "walk_in_only":
      return refuse("That table is for walk-ins only, and an online booking can't be moved to it.", 409);
    case "taken":
      return refuse("That table is booked for part of this booking's time. Choose another.", 409);
    case "moved":
      return formSaved(request, "/dashboard/bookings");
  }
}
