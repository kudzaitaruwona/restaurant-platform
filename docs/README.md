# Restaurant Platform: Product Specs

A multi-tenant platform for sit-down restaurants in Zimbabwe. It covers the menu, autonomous bookings, and (later) QR ordering at the table.

**Strategy: land and expand.** The platform goes in free as a lightweight layer next to the restaurant's existing swipe machine. Once it has proven itself and the restaurant trusts it, it comes back to replace their POS. Nothing in v1 touches the restaurant's payments.

## Spec index

| # | Spec | Status | Build phase |
|---|------|--------|-------------|
| 00 | [Data model](specs/00-data-model.md) | Draft | All |
| 01 | [Tenancy, staff and platform admin](specs/01-tenancy-and-staff.md) | Draft | 1 |
| 02 | [Menu and public menu page](specs/02-menu.md) | Draft | 2 |
| 03 | [Tables and QR codes](specs/03-tables-and-qr.md) | Draft | 3 |
| 04 | [Autonomous bookings](specs/04-bookings.md) | Draft | 4 |
| 05 | [Booking notifications (WhatsApp)](specs/05-booking-notifications.md) | Draft | 5 |
| 06 | [QR table ordering and sessions](specs/06-qr-ordering.md) | **Blocked** on [D-01](decisions.md#d-01-fake-remote-qr-orders) | 6 |
| 07 | [Kitchen view](specs/07-kitchen-view.md) | Draft (ships with 06) | 6 |

Decisions, both settled and open, are tracked in [decisions.md](decisions.md).

## Build order

1. **Tenancy and staff.** This has to exist before anything else does.
2. **Menu and public menu page.** This is the first thing you demo.
3. **Tables and QR codes.** Table codes point to the menu until ordering ships, so printed codes never need reprinting.
4. **Bookings.** A web booking page with autonomous table assignment, plus a staff day view.
5. **WhatsApp notifications.** Booking confirmations and reminders through templates only, with no chatbot.
6. **QR ordering and kitchen view.** These wait until the fraud decision (D-01) is made.

Bookings come before ordering because a real prospect asked for hands-off booking. QR ordering has no demand evidence yet.

## Product principles (non-negotiable)

- **No customer-facing fees or surcharges.**
- **Minimal customer data.** Ordering asks for a name only. Booking also asks for a WhatsApp number, because reminders can't work without one. Receipts are opt-in.
- **QR ordering works alongside waiters, not instead of them.**
- **The public menu page is lightweight and fast on weak mobile connections.**
- **Bookings are autonomous by default, with a human override.** A booking that needs a staff tap to confirm has failed the core promise.
- **Multi-tenant from day one.** Every row carries `restaurant_id`, and every foreign key includes it.

## How to read the specs

Each spec labels its content in one of two ways:

- **Decided** means Kudzai made the call. Change it only on purpose, and update `decisions.md` when you do.
- **Proposed** means it's a sensible default that hasn't been confirmed yet. It's safe to build as written, but confirm it before going live.
