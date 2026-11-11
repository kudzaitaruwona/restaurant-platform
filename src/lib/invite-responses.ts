import { notFound } from "next/navigation";
import { INVITES_PER_HOUR, type ResendOutcome } from "./invites";

/**
 * What "Send invite again" answers (S-42), on the staff screen and the owner
 * card alike. The person is there either way; only the email is in question.
 */
export function inviteResponse(outcome: ResendOutcome, sent: () => Response) {
  switch (outcome) {
    case "sent":
      return sent();
    case "not_found":
      notFound();
    case "joined":
      return Response.json({ error: "They've already signed in." }, { status: 409 });
    case "too_many":
      return Response.json(
        {
          error: `They've been sent ${INVITES_PER_HOUR} invites in the last hour. Try again later.`,
        },
        { status: 429 },
      );
    case "not_sent":
      return Response.json(
        { error: "The invite email didn't go. Try again in a few minutes." },
        { status: 502 },
      );
  }
}
