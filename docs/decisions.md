# Decision Log

## Settled

| ID | Decision | Notes |
|----|----------|-------|
| S-01 | Target segment: sit-down (dine-in) restaurants in Zimbabwe | |
| S-02 | Land and expand: free layer beside the existing swipe machine, POS replacement later | |
| S-03 | Multi-tenant from day one, with `restaurant_id` on every row and in every FK | |
| S-04 | Kudzai hand-onboards the first ~10 venues himself; self-serve editing exists from the start | Requires a platform-admin role (spec 01) |
| S-05 | Build order: menu, then bookings, then QR ordering. WhatsApp comes after the web booking page. | |
| S-06 | Bookings must be autonomous: accept or decline and confirm with no staff action | Driven by a real prospect's request |
| S-07 | Availability is based on **real table assignment**, not covers per slot | Decided 2026-10-22 |
| S-08 | v1 reminders use **WhatsApp template messages only** (no chatbot) | Decided 2026-10-22 |
| S-09 | **No booking deposits in v1** | Decided 2026-10-22 |
| S-10 | Prices in USD and ZiG. An item may have a fixed ZiG price; otherwise ZiG is computed from the restaurant's rate. The restaurant chooses how currencies are displayed. | |
| S-11 | One category per menu item | |
| S-12 | Specials: single-item promotions, plus bundles modelled as special-only items | |
| S-13 | Tables are modelled as a label plus capacity. A QR code is auto-generated when a table is added, and printable. | |
| S-14 | Per-table QR tokens are random and permanent, and staff can regenerate them. A generic QR code is menu-view only. | |
| S-15 | Customers are anonymous (no account). Staff log in. Protected actions require staff login. | |
| S-16 | ~~Multiple staff logins per restaurant with equal access, soft-limited to one on the standard plan. A `role` column exists now.~~ | **Superseded by S-26** |
| S-17 | Table sessions: one open session per table, latecomers join it, and it closes on any of several triggers | Spec 06 |
| S-18 | Undelivered items block session close. Staff can force-close by voiding items with a reason. | |
| S-19 | Idle expiry happens after 90 minutes of no activity | |
| S-20 | Staff-only reopen within 15 minutes of close | |
| S-21 | Order lines freeze the price at order time | |
| S-22 | Order status is tracked per item: placed → cooking → done → delivered (plus voided) | |
| S-23 | Ordering asks for the customer's name only | |
| S-24 | Kitchen view shows the order, its table, and per-item notes | |
| S-25 | **Auth is deferred.** Build every feature behind a tenant seam: `getTenantContext()` is the only source of tenant identity, and `withTenant()` sets `app.restaurant_id` per transaction with RLS on. In development, `DEV_AUTH_BYPASS` returns a seeded staff member, and a dev-only switcher swaps between seeded identities. The app refuses to start if the bypass is set in production. Real login (Better Auth) is the last chain-1 ticket and must ship before the first real venue is onboarded. | Decided 2026-10-22. Spec 01 |
| S-26 | **Two roles: owner and staff.** `staff.role` is `(owner, staff)`. A restaurant's first staff record is its owner, and the database guarantees every restaurant always has at least one active owner. Owner only: menu, categories, prices, specials, exchange rate, staff management, tables and QR regeneration, booking settings and closures, restaurant settings. Owner and staff: sold-out toggle, every booking day-view action, kitchen statuses, mark delivered, clear table, and void or force-close with a required, audited reason. Role checks live in the app layer, and RLS stays tenant-only. The soft limit counts owner logins only; staff logins are unlimited. The platform admin's shadow staff row (`kind = platform_admin`) gets `role = owner` for permission checks but is excluded from both the soft-limit count and the last-owner rule. | Decided 2026-10-22. Supersedes S-16. Specs 00, 01 |
| S-27 | **Passwordless staff sign-in:** magic link, email one-time code, or Sign in with Google. No passwords are stored. Sign-in only works for an email that already belongs to an active staff record or platform admin; nobody can sign themselves up. | Decided 2026-10-22. Implemented in the "Real staff login" ticket (S-25). Specs 00, 01 |

## Open

### D-01: Fake remote QR orders
**Blocks spec 06.** Someone could photograph a table's QR code and place orders from anywhere.

Options:
1. **Staff approve new sessions.** The first order at a table pings staff to accept. Anyone joining an already-approved session isn't asked. That costs one tap per table, not one per order.
2. **Per-table code.** Customers enter a short code shown at the table. No staff tap, but every party has to type it.
3. **Both, chosen per restaurant.** The most flexible option, and the most to build and test.

Recommendation: option 1. Decide before starting phase 6, ideally after watching real service this summer.

### D-02: Large parties and combined tables
v1 assigns exactly one table per booking. Parties larger than the biggest bookable table, or larger than `max_online_party_size`, see a "contact the restaurant" message instead. Revisit this if venues regularly push tables together for groups.

### D-03: Reminder timing
Proposed: one reminder 3 hours before the booking, skipped if the booking was made less than 3 hours ahead. An alternative is a day-before reminder plus a same-day one. That costs more per booking in Meta template fees.

### D-04: Recurring specials ("every Tuesday 5–9pm")
Proposed: add `days_of_week` and a daily time-window column now, and build the recurring logic only once a restaurant asks for it.

### D-05: Overlapping specials on one item
Proposed: the database rejects a second active special that overlaps on the same item.

### D-06: Guest phone number retention
A booking needs a WhatsApp number. Proposed: null the number 30 days after the booking date, keeping only the name and the booking outcome for no-show stats.

### D-07: Stack choices — **resolved 2026-10-22**
- **Neon Postgres with Drizzle ORM, using Neon's WebSocket `Pool` driver, not the HTTP driver.** RLS needs `set_config('app.restaurant_id', …, true)` inside an interactive transaction, and booking confirm needs `SAVEPOINT`s. The HTTP driver supports neither.
- **Cloudflare R2 for photos**, served from a custom domain (never `r2.dev`). App code only touches storage through an `uploadImage` / `deleteImage` / `getUrl` interface.
- **Better Auth for staff and platform-admin sessions**, implemented last (see S-25).
- Vercel Blob is no longer used.

### D-08: Product name and plan pricing
The repo is named `restaurant-platform` as a working name. Pricing is undefined: the "standard plan" soft limit needs a plan to attach to. Per S-26, the soft limit counts **owner** logins only; staff logins are unlimited.
