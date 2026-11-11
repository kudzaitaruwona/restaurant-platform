import { html, trusted } from "@/lib/html";
import type { CancelOutcome, ManagedBooking } from "@/lib/bookings";
import { displayPhone } from "@/lib/display-phone";
import { guestThemeCss } from "@/lib/guest-theme";

/**
 * The guest's manage page (spec 04), written by hand like the menu (S-32): no
 * React, no script, one inline stylesheet. Its URL is a bearer secret, so the
 * response says never to cache it and never to pass it to another site in a
 * Referer, and the page carries no link off the site except the restaurant's own
 * `tel:` number. The policy is same-origin, not no-referrer: under no-referrer
 * Chrome posts the cancel form with Origin: null, and the proxy refuses that.
 */

export const tooLateMessage = "Too late to cancel online. Please call.";

/**
 * The guest theme (S-41) and this page's own few rules. Icons are Lucide's own
 * paths, inline: there is no script or webfont to load them.
 */
const styles = `${guestThemeCss}
main{max-width:480px;margin:0 auto;padding:24px 16px 48px;display:flex;flex-direction:column;gap:16px}
h1{margin:0;font-size:24px;line-height:1.25;font-weight:600;letter-spacing:-.015em}
p{margin:0}
.card{padding:16px;display:flex;flex-direction:column;gap:4px}
.when{font-size:20px;font-weight:600;line-height:1.3}
.card .muted{font-size:15px}
.btn{min-height:48px;font-size:16px}
.btn-cancel{background:transparent;border-color:var(--danger);color:var(--danger)}
@media (hover:hover){.btn-cancel:hover{background:var(--danger-soft)}}
.contact{font-size:15px}
.contact a{color:var(--ink);text-underline-offset:3px}
`;

const icon = (paths: string) =>
  trusted(`<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`);
const icons = {
  info: icon('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'),
  circleX: icon('<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>'),
  phone: icon(
    '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
  ),
};

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

/** A message in place: grey to inform, red once the booking is cancelled. */
const message = (
  text: string,
  tone: "neutral" | "cancelled",
  glyph = tone === "cancelled" ? icons.circleX : icons.info,
) =>
  html`<div class="${tone === "cancelled" ? "notice notice-danger" : "notice"}" role="status">${glyph}<p>${text}</p></div>`;

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
${notice && message(notice, outcome === "cancelled" ? "cancelled" : "neutral")}
<div class="card">
<p class="when">${booking.dateLabel} at <span class="num">${booking.time}</span></p>
<p class="muted">${booking.guestName}, party of ${booking.party}</p>
${booking.note && html`<p class="muted">Your note: ${booking.note}</p>`}
</div>
${state && !notice && message(state, booking.status === "cancelled" ? "cancelled" : "neutral")}
${
  booking.cancellable
    ? html`<form method="post" action="${`/b/${encodeURIComponent(token)}`}">
<button class="btn btn-cancel btn-block" type="submit">Cancel booking</button>
</form>`
    : booking.status === "confirmed" && message(tooLateMessage, "neutral", icons.phone)
}
${contactPhone && html`<p class="contact muted">Restaurant: <a class="num" href="${`tel:${contactPhone}`}">${displayPhone(contactPhone)}</a></p>`}`,
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
