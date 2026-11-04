import { notFound } from "next/navigation";
import type { ActionOutcome } from "./booking-day";
import { formSaved } from "./form-response";

const statusWords = {
  confirmed: "confirmed",
  seated: "seated",
  completed: "finished",
  cancelled: "cancelled",
  no_show: "marked as a no-show",
} as const;

/**
 * Answers a day view action. A 409 says what the booking is now, so the second of
 * two staff tapping at once, or one who raced the guest's own cancel, sees why
 * nothing happened.
 */
export function bookingActionResponse(outcome: ActionOutcome, request: Request, action: string) {
  if (outcome.outcome === "not_found") notFound();
  if (outcome.outcome === "wrong_status") {
    return Response.json(
      {
        error: `${action} didn't apply: this booking is already ${statusWords[outcome.status]}. Reload to see the latest.`,
      },
      { status: 409 },
    );
  }
  if (outcome.outcome === "table_taken") {
    return Response.json(
      { error: "Another booking was just made on this table, right after this one. Try Finish again." },
      { status: 409 },
    );
  }
  return formSaved(request, "/dashboard/bookings");
}
