import { html, trusted } from "@/lib/html";
import type { CancelOutcome, ManagedBooking } from "@/lib/bookings";

/**
 * The guest's manage page (spec 04), written by hand like the menu (S-32): no
 * React, no script, one inline stylesheet. Its URL is a bearer secret, so the
 * response says never to cache it and never to pass it to another site in a
 * Referer, and the page carries no link off the site except the restaurant's own
 * `tel:` number. The policy is same-origin, not no-referrer: under no-referrer
 * Chrome posts the cancel form with Origin: null, and the proxy refuses that.
 */

export const tooLateMessage = "Too late to cancel online — please call.";

const styles = `
:root{color-scheme:light dark;--muted:#5f5f5f;--line:#e2e2e2}
@media (prefers-color-scheme:dark){:root{--muted:#a8a8a8;--line:#3a3a3a}}
*{box-sizing:border-box}
body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:32rem;margin:0 auto;padding:1.5rem 1rem 3rem}
h1{margin:0 0 1rem;font-size:1.75rem;line-height:1.2}
p{margin:.5rem 0}
.muted{color:var(--muted)}
.notice{padding:.75rem 1rem;border:1px solid var(--line);border-radius:.5rem}
button{font:inherit;padding:.6rem 1rem;border-radius:.5rem;border:1px solid currentColor;background:none;color:inherit;cursor:pointer}
`;

const page = (title: string, body: ReturnType<typeof html>) =>
  html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="same-origin">
<title>${title}</title>
<style>${trusted(styles)}</style>
</head>
<body><main>${body}</main></body>
</html>
`;

const stateOf = ({ status, cancelledBy }: ManagedBooking) => {
  switch (status) {
    case "confirmed":
      return null;
    case "seated":
      return "This booking is under way: you're seated.";
    case "completed":
      return "This booking is complete.";
    case "no_show":
      return "This booking was marked as a no-show.";
    case "cancelled":
      return cancelledBy === "staff"
        ? "This booking was cancelled by the restaurant."
        : "This booking is cancelled.";
  }
};

const noticeOf = (outcome: CancelOutcome["outcome"] | undefined) => {
  switch (outcome) {
    case "cancelled":
      return "Your booking is cancelled.";
    case "already_cancelled":
      return "This booking was already cancelled.";
    default:
      return null;
  }
};

function bookingPage(booking: ManagedBooking, token: string, outcome?: CancelOutcome["outcome"]) {
  const state = stateOf(booking);
  const notice = noticeOf(outcome);
  const { contactPhone } = booking;
  return page(
    `Your booking at ${booking.restaurantName}`,
    html`<h1>${booking.restaurantName}</h1>
${notice && html`<p class="notice" role="status">${notice}</p>`}
<p>${booking.guestName}, party of ${booking.party}</p>
<p>${booking.dateLabel} at ${booking.time}</p>
${booking.note && html`<p class="muted">Your note: ${booking.note}</p>`}
${state && !notice && html`<p class="notice" role="status">${state}</p>`}
${
  booking.cancellable
    ? html`<form method="post" action="${`/b/${encodeURIComponent(token)}`}">
<button type="submit">Cancel booking</button>
</form>`
    : booking.status === "confirmed" &&
      html`<p class="notice" role="status">${tooLateMessage}</p>`
}
${contactPhone && html`<p class="muted">Restaurant: <a href="${`tel:${contactPhone}`}">${contactPhone}</a></p>`}`,
  );
}

const notFound = page(
  "Booking not found",
  html`<h1>Booking not found</h1>
<p class="muted">Check the link in your confirmation, or ask the restaurant.</p>`,
);

/**
 * Every response from this route says the same about its URL, found or not,
 * because the token is in it either way.
 */
const headers = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "private, no-store",
  "referrer-policy": "same-origin",
  "x-robots-tag": "noindex, nofollow",
};

export const notFoundResponse = () =>
  new Response(notFound.toString(), { status: 404, headers });

export function bookingResponse(token: string, booking: ManagedBooking, outcome?: CancelOutcome["outcome"]) {
  const refused = outcome === "too_late" || outcome === "not_cancellable";
  return new Response(bookingPage(booking, token, outcome).toString(), {
    status: refused ? 409 : 200,
    headers,
  });
}
