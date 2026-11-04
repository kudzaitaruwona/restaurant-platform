# 04 · Autonomous Bookings

**Phase 4.** This is the headline feature, and the one a real prospect asked for.

## Goal
Take a staff member off phone and WhatsApp booking duty. Guests book online at any hour and get an instant yes or no. The system assigns a real table, confirms the booking, and (spec 05) reminds the guest, with no staff involvement. Staff can override anything.

The pitch the owner should feel: **"Nobody has to answer the phone for bookings any more, and fewer people don't turn up."**

## Decided
- **Autonomous by default.** A booking is confirmed or declined instantly. There is no "pending staff approval" state.
- **Availability comes from real table assignment.** Each booking holds a specific table for its sitting length plus a buffer. It is not based on covers per slot.
- **No deposits in v1.**
- **Web booking page first.** Reminders go out as WhatsApp templates (spec 05). There is no chatbot.

## What the guest sees

### Booking page `/r/{slug}/book`
1. **Party size**: 1 up to `max_online_party_size`, plus a final **"{max}+"** option that goes straight to the contact message
2. **Date**: today up to `max_days_ahead`, comparing *local* dates. A date is disabled if it has no service period, or if closures leave it with no candidate times. Partly closed dates stay enabled and just show fewer times.
3. **Available times**, grouped by service period ("Lunch", "Dinner"). Only times that can actually be seated are shown.
4. **Details:** name (required), WhatsApp number (required, with the country code defaulting to +263), an optional note (200 characters), and a required consent checkbox: *"Send my confirmation and reminder on WhatsApp."*
5. **Confirm**, then an instant confirmation screen showing restaurant, date, time and party size, a **"Cancel booking" link**, and the restaurant's contact number.

The guest never sees which table they've been given.

*(Proposed)* How the page behaves where the steps above leave it open:
- An unknown slug shows a "Restaurant not found" page, kept out of search engines. The HTTP status is 200 on a production build, not 404: an App Router page sends its shell before the slug can be looked up (S-32 in detail). The confirm route, `POST /api/r/{slug}/book`, answers a real 404.
- While online booking is off, the page says so and shows the contact number. Confirm refuses on the server too.
- A name is 1 to 100 characters. The number is stored as E.164: a leading 0 is dropped, and a number typed with its own `+` keeps its own country code.
- A date is also disabled once every time on it is inside the lead time. A date that's only full stays enabled and says no tables are free.
- The race-lost response offers up to 4 times, on the same date, closest first.
- Confirming needs JavaScript, so that a refusal keeps what was typed without putting a phone number in a URL. The earlier steps are plain links and a GET form.

**Party too large** (the "{max}+" option, or a size bigger than every bookable table): the page says "For groups of {n}+, contact the restaurant" and shows the phone and WhatsApp click-to-chat link (`restaurants.contact_phone`). This covers D-02.

### Refusals at confirm
Confirm re-checks everything, so it can refuse a time the list just showed. Every refusal keeps the details the guest entered.

| Reason | Message |
|--------|---------|
| Race lost (every candidate table was taken in between) | "That time was just booked — here are the nearest available times." |
| Lead time passed while the page was open | "That time is now too soon to book online — here are the next available times." |
| Phone already has `max_active_bookings_per_phone` future bookings | "You already have {n} upcoming bookings here. Cancel one or contact the restaurant." |
| Bot check failed | "We couldn't verify the request — please try again." |

### Manage page `/b/{manage_token}`
- Shows the booking. **Cancel** is available until `guest_cancel_cutoff_minutes` before the start. After that it shows "Too late to cancel online — please call."
- No editing in v1. To change a booking, the guest cancels and books again.

*(Proposed)* How the page behaves where the lines above leave it open (ticket #34):
- It is a Route Handler that writes its own HTML, like the menu (S-32), so an unknown token is a real 404 and the response headers are the page's own. It ships no script.
- The token is a bearer secret in the URL, so every response, found or not, carries `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex`. The page links nowhere off the site except the restaurant's `tel:` number.
- **GET only reads. Cancel is a POST** to the same URL, from a form on the page, so a link preview or a prefetch can't cancel. The proxy refuses a cross-site POST. The request carries nothing but the token: the instant is Postgres's `now()`, never the client's.
- Cancel is one status-guarded `UPDATE` (`status = 'confirmed'` and `now() <= starts_at - guest_cancel_cutoff_minutes`), so a guest cancel can't overwrite a staff Seat or No-show that lands first. The cutoff is inclusive: exactly `guest_cancel_cutoff_minutes` before the start still cancels. It sets `cancelled_by = guest` and `cancelled_at`, which frees the table.
- Cancelling twice is safe and says "This booking was already cancelled." A `seated`, `completed` or `no_show` booking shows that state and has no cancel, and so does one staff cancelled. A confirmed booking past the cutoff shows "Too late to cancel online — please call." and the restaurant's number.
- The guest sees the restaurant, their name, the date and time on the restaurant's clock, the party size, their note and the state. Never the table, their phone, or anyone else's booking.
- A guest's cancel isn't audited: spec 01's audit list covers staff's cancellations, and the row records `cancelled_by = guest` and when. The cancellation WhatsApp message is queued once spec 05 lands (5.3).

## The availability engine

### Inputs
Party size `p`, local date `d`, and the restaurant's `booking_settings`, `service_periods`, `closures`, `tables` and active `bookings`.

### Algorithm
```
tz        = restaurants.timezone
reject d  if d < local_today(tz) or d > local_today(tz) + max_days_ahead   -- local dates, not instants
sitting   = p >= large_party_size ? large_party_sitting_minutes : sitting_minutes
candidates = for each service_period on weekday(d):        -- periods can't overlap (DB constraint)
               local times from opens_at to last_booking_at, step slot_interval_minutes
               t = (d + local_time) AT TIME ZONE tz        -- every comparison below uses instants
drop t if  t < now() + min_lead_minutes
           [t, t + sitting) overlaps any closure
hold(t)   = [t, t + sitting + buffer_minutes)
tables(p) = bookable, not archived, capacity >= p,
            ordered by capacity ASC, sort_order ASC          -- best fit
t is available  ⇔  ∃ table in tables(p) with no confirmed/seated/completed booking overlapping hold(t)
```

*(Proposed)* `completed` counts too, because the exclusion constraint counts it. Without it the list would offer a table during the reset buffer after an early finish, and confirm would refuse it.

### Assigning on confirm
1. Re-run the refusal checks (lead time, per-phone limit, bot check).
2. Recompute candidate tables for the chosen time, using best fit.
3. For each candidate: `SAVEPOINT`, then `INSERT`. On `exclusion_violation`, `ROLLBACK TO SAVEPOINT` and try the next candidate. **Without the savepoint, the first violation aborts the whole transaction and every later attempt fails.**
4. If every candidate fails, return the "race lost" response with the nearest available times.

*(Proposed)* A `deadlock_detected` error counts as an `exclusion_violation` here. Two inserts landing together can each wait on the other's unfinished row, and Postgres then fails one of them, inside its savepoint, so that one tries its next candidate.

**The database constraint is the source of truth.** The app's availability check only keeps the UI honest. It is not what prevents double bookings.

### Known weakness (accepted for v1)
Best fit can still put a couple on the 8-top when it's the only table free at 7pm, which then blocks a party of 8 at 7:30. Watch real booking data before adding a "max spare seats" rule.

## What staff see

### Day view `/dashboard/bookings` (defaults to today)
Staff pages live under `/dashboard/*` *(proposed)*, see D-10.
- **List by time**, grouped by service period. Bookings outside every period (staff-added or walk-ins) appear under "Other". Each row shows time, guest name, party size, table, status, note, and tap-to-call and WhatsApp buttons (`tel:` and `wa.me` links).
- A per-table timeline view is optional. The list ships first because it works on a phone.
- A date picker for other days.
- Header counts: bookings and covers per service period.

### Staff actions
| Action | Effect |
|--------|--------|
| **Seat** | `confirmed → seated` |
| **Finish** | `seated → completed`. Sets `ends_at = greatest(starts_at + 1 min, now())` and `hold_ends_at = ends_at + buffer_minutes`, so the table becomes bookable again after the reset buffer, not at the original end time. *(Proposed)* Both are clamped so `hold_ends_at - starts_at` stays within 960 minutes (the `bookings_hold_capped` CHECK, spec 00). |
| **No-show** | `confirmed → no_show`. Frees the table. |
| **Cancel** | `→ cancelled`, `cancelled_by = staff`. Queues a cancellation message (spec 05). |
| **Move table** | Pick any table that's free for the hold window. The DB constraint still applies. No message to the guest, who never knew the table. |
| **Add booking** | The same engine, but staff may: book inside the lead time, exceed `max_online_party_size`, pick the table by hand, and leave the phone blank. `source = staff`. |
| **Walk-in** | "Seat walk-in" on a table asks for the **party size**, then creates a `seated` staff booking: `guest_name = 'Walk-in'`, phone null, `whatsapp_opt_in = false`, `starts_at = now()`. `ends_at = min(now + sitting, next booking's starts_at on that table − buffer)`. If that leaves under 30 minutes, staff see "Table 7 has a booking at 19:00 — move that booking, or seat the walk-in elsewhere" instead. This stops the engine selling a table that's physically occupied. |

Changing a booking's time in v1 means cancel plus a new booking. That keeps the messaging simple.

### Automatic status changes (proposed)
- `confirmed` and not seated by `starts_at + 30 min`: highlighted as **Late** in the day view. Nothing automatic happens, and staff decide.
- `confirmed` and still not seated at `ends_at`: the system marks it `no_show` (`actor_type = system`).
- `seated` and past `hold_ends_at`: the system marks it `completed`. *(Proposed)* It clamps `ends_at` and `hold_ends_at` the same way, so `hold_ends_at - starts_at` stays within 960 minutes.

These run on the same scheduled job as notifications (spec 05).

### Settings `/dashboard/bookings/settings` (D-10)
- Enable or disable online booking. Enabling is blocked until at least one service period, one bookable table, and `restaurants.contact_phone` all exist. The contact number appears on the large-party message and in cancellation messages.
- Service periods per weekday, with several allowed (lunch and dinner), each with a name, opening time, last booking time, and closing time. Periods can't overlap or cross midnight in v1.
- *(Proposed)* Enabling is enforced by Postgres, not just the screen: a trigger refuses to set `enabled` while any of the three is missing, and the refusal names what is missing. The same three are rechecked when the last service period is deleted, the last bookable table is archived or made walk-ins only, or `contact_phone` is cleared: booking is then **switched off automatically**, so enabling at the moment the last table is archived can't commit with nothing to book.
- *(Proposed)* A period's name is 1 to 50 characters, and its closing time is no later than 23:59. Periods are `[opens_at, closes_at)`, so one may close at the minute the next opens.
- Closures (date or datetime ranges, with a reason). **Saving a closure that covers existing confirmed bookings** lists those bookings first. Staff must move or cancel each one (cancelling sends the guest a cancellation message) before the closure saves.
- Sitting lengths, buffer, lead time, days ahead, max online party size, and cancel cutoff (all from `booking_settings`).
- A **copy-able booking link** and a QR code to share on Instagram, WhatsApp status or a Google profile.

## Abuse controls (proposed)
- At most `max_active_bookings_per_phone` (default 2) future confirmed bookings per phone number per restaurant.
- Rate limit on booking submissions: 5 per IP per 10 minutes.
- An invisible bot check (Cloudflare Turnstile) on the confirm step.
- No phone verification in v1. A fake number can still hold a table, and staff can cancel it. Revisit if it happens.

## Data and privacy
- Data collected: name, WhatsApp number, party size, and optional note. Nothing else.
- *(Proposed, D-06)* The phone number is nulled 30 days after the booking date. The name and outcome stay, for no-show stats.
- Consent to WhatsApp messages is stored in `whatsapp_opt_in`. Meta requires it.

## Success metrics (the proof for the pitch)
Track these per restaurant from day one, because they're what wins the next ten venues:
- **Bookings made while staff weren't answering**: online bookings whose `created_at`, in local time, falls outside every service period's `opens_at`–`closes_at` for that weekday. This shows hands-off value.
- **No-show rate**, compared with what the owner estimates they had before
- **Share of bookings made online** versus added by staff

## Out of scope (v1)
- Deposits and payments
- Waitlist
- Combined tables (D-02)
- Guest-side editing
- Two-way WhatsApp booking (chatbot)

## Acceptance
- [ ] Two simultaneous confirms for the last free table: exactly one succeeds, and the other gets the race-lost response (automated concurrency test against real Postgres).
- [ ] For the same inputs at the same instant, the availability list and confirm agree. Each refusal reason in the table above returns its own message.
- [ ] Choosing "{max}+" shows the contact message with the restaurant's number, not an empty time list.
- [ ] A closure covering 7–10pm on a date removes those times, including sittings that would run into it.
- [ ] Saving a closure over existing bookings is blocked until those bookings are moved or cancelled.
- [ ] Seating a walk-in removes that table from online availability for its sitting. A walk-in that would collide with a booking within 30 minutes is refused with the move-or-elsewhere prompt.
- [ ] Finishing a seated booking early makes the table bookable from `now + buffer`.
- [ ] A guest can cancel before the cutoff and can't after it.
- [ ] Availability computed with the server in UTC for a restaurant in `Africa/Harare` matches the same computation done in local time, including on the last bookable day.
