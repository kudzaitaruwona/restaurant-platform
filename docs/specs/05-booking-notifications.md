# 05 · Booking Notifications (WhatsApp Templates)

**Phase 5.** This is the no-show half of the booking pitch.

## Goal
Every confirmed booking gets a WhatsApp confirmation and a reminder, sent automatically. The reminder makes cancelling easy, so a table that would have been a no-show becomes a freed table.

## Decided
- **WhatsApp template messages only, with no chatbot.** Messages are outbound only, and the guest acts through links.
- No SMS or email fallback in v1.

## ⚠️ Critical path: start Meta setup now, not in phase 5
WhatsApp Business messaging requires Meta Business verification, a WhatsApp Business Account, an approved display name, and **pre-approved message templates**. Each of these is a review step with its own turnaround that you don't control. If it isn't started until the code is ready, it becomes the thing that delays the summer launch.

- **Build against Meta's test phone number** while verification is pending. The Cloud API provides one for development.
- Submit templates as soon as their wording is final (below).

## Sending model (proposed)
- **One platform-owned WhatsApp number** sends for every restaurant. Messages name the restaurant in the body.
- Per-restaurant numbers would make each venue go through Meta verification, which defeats "effortless first yes." Revisit only if a venue insists on its own number.
- Direct integration with the **WhatsApp Cloud API** (Meta-hosted), with no third-party provider markup. Twilio and similar providers are a fallback if Meta onboarding stalls.

## Templates (utility category)

All buttons are **URL buttons** pointing to the manage page, so there is no inbound webhook logic in v1.

**`booking_confirmed`**
> Hi {{1}}, your table at {{2}} is confirmed for {{3}} people on {{4}} at {{5}}. Need to cancel? Use the button below. This number doesn't receive replies — to reach the restaurant, call {{6}}.
> [Manage booking] → `/b/{manage_token}`

**`booking_reminder`**
> Hi {{1}}, a reminder of your booking at {{2}} on {{3}} at {{4}} for {{5}} people. Can't make it? Please cancel so someone else can have the table.
> [Manage booking]

The reminder names the date rather than saying "today", so the same approved template works whatever D-03 settles on.

**`booking_cancelled`**
> Hi {{1}}, your booking at {{2}} on {{3}} at {{4}} has been cancelled. {{5}}
> ({{5}} = "We hope to see you another time." when the guest cancelled, or the restaurant's contact line when staff cancelled)

The wording is draft. Templates need Meta approval, so lock them in before submitting.

## Scheduling (outbox pattern)

| Event | Queued |
|-------|--------|
| Booking confirmed (with opt-in and a phone number) | `booking_confirmed` now, plus `booking_reminder` at `starts_at − 3h` *(proposed, D-03)*. The reminder is skipped if that time has already passed. |
| Booking cancelled (by guest or staff) | Pending reminder → `cancelled`. `booking_cancelled` now. |
| Booking marked no-show or completed | Pending reminder → `cancelled` |

- A job runs **every 5 minutes**.
- **Claim, then send.** In one short transaction, update due rows from `pending` to `sending` with `claimed_at = now()`, selecting them with `FOR UPDATE SKIP LOCKED`. Commit, then send each claimed row and set `sent` with `provider_message_id`. Overlapping job runs can't claim the same row.
- `UNIQUE (booking_id, kind)` only prevents duplicate *rows*. Duplicate *sends* are prevented by the claim.
- **Crash recovery is at-least-once:** a row stuck in `sending` for more than 10 minutes returns to `pending`. If the crash happened after Meta accepted the message, the guest gets it twice. That's accepted, because a rare duplicate is better than a lost reminder.
- Retry: up to 3 attempts with backoff, then `failed`.
- **Before sending, re-check the booking's status for that message kind.** `booking_confirmed` and `booking_reminder` require `status = confirmed`. `booking_cancelled` requires `status = cancelled`. On a mismatch, mark the row `cancelled` without sending. A reminder for a cancelled booking is worse than no reminder.
- The same job runs the booking auto-status rules from spec 04 and the phone retention purge *(proposed, D-06)*.
- This job and the Meta webhook work across all tenants, so they use the privileged database role described in spec 01.

**Hosting check:** Vercel cron frequency depends on the plan, and the Hobby plan doesn't run jobs every few minutes. Either use a paid plan or trigger the job from an external scheduler, such as Upstash QStash or a GitHub Actions schedule calling a secret-protected route. Decide this before phase 5.

## Delivery status
- A Meta webhook receives `sent`, `delivered`, `read` and `failed` statuses and updates `notifications.status`. Verify the webhook signature with the app secret.
- **Staff day view:** show a small warning icon on a booking whose confirmation `failed`, for example when the number isn't on WhatsApp. Staff can then call the guest. The booking itself stays valid.

## Data and privacy
- Only send when `whatsapp_opt_in = true` and `guest_phone` is set.
- Never send marketing messages through these templates. Utility-category templates must stay strictly transactional, or Meta can reclassify or block them.

## Cost
Meta charges per template message, and rates vary by country. Check Meta's current rate card for Zimbabwean numbers before setting any pricing (D-08). At roughly 2–3 messages per booking, this is the platform's main variable cost.

## Out of scope (v1)
- Inbound replies and chatbot handling. Guests who reply get no automated answer, which is why the confirmation template says the number doesn't receive replies and gives the restaurant's number.
- Quick-reply buttons (they would need inbound webhook handling)
- Order receipts by WhatsApp (phase 6+)

## Acceptance
- [ ] Confirming a booking sends `booking_confirmed` within 5 minutes (test number).
- [ ] Cancelling before the reminder time means no reminder is ever sent.
- [ ] Two job runs started at the same moment each claim different rows, and every due notification is sent exactly once.
- [ ] A `booking_cancelled` message is sent for a cancelled booking, and a reminder is not.
- [ ] A failed delivery shows a warning on the staff day view.
- [ ] A webhook with an invalid signature is rejected.
