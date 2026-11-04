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
| S-28 | **Platform-admin writes go through narrow `SECURITY DEFINER` functions, not a broader role.** `app_tenant` can't create a restaurant, and outside a tenant it can't see one or write `audit_log`, so `platform_create_restaurant`, `platform_create_first_owner` and `platform_list_restaurants` do those jobs and nothing else (migration `platform_admin_functions`). Each pins `search_path`, and only `app_tenant` can execute it. `DATABASE_URL_SYSTEM` stays for the scheduled job and the Meta webhook. **Postgres can't tell who is asking, because every request is `app_tenant`.** Four things stop a tenant identity: (1) `getPlatformAdminContext()` guards every admin route, and only `src/lib/tenant/platform-admin.ts` calls the functions; (2) the functions refuse to run with `app.restaurant_id` set, so nothing inside `withTenant()` gets through; (3) they need a real `platform_admins.id`, which is attribution and not authentication, because `audit_log` shows that id to the tenant; (4) the first-owner function refuses a restaurant that already has staff, so an onboarded restaurant can't be taken over even if (1) to (3) fail. **What doesn't hold:** code running arbitrary SQL as `app_tenant` can clear the setting with `set_config`, just as it can already set it to get past RLS. It could then create junk restaurants, read the list (names, slugs, timezones, currency modes) and become first owner of a restaurant with no staff yet. Every write is audited. A separate login role for the admin path is the only thing that would stop this; add one if the admin path ever gains power over onboarded restaurants. | Decided 2026-11-04. Ticket #14. Spec 01 |
| S-29 | **`audit_log.actor_id` for a platform admin is always `platform_admins.id`, never a shadow staff id**, inside a restaurant as well as outside. Creating a restaurant happens before any shadow row can exist, and one id across every restaurant lets a single query answer "what did this admin do". `actor_type` says which table the id belongs to. Shadow staff rows still satisfy the `→ staff` foreign keys (spec 00); they just don't appear in `audit_log`. | Decided 2026-11-04. Ticket #14. Specs 00, 01 |
| S-30 | **How staff sign-in works (S-27).** See "S-30 in detail" below. Two Better Auth instances, one per session type, each with its own cookie and tables. Lookups before a tenant exists go through two narrow `SECURITY DEFINER` functions. Better Auth's tables are visible only outside a tenant. Cross-site writes are refused by an Origin check as well as SameSite=Lax. | Decided 2026-11-04 in the "Real staff login" ticket. Spec 01 |

### S-30 in detail
- **Sign-in lookup.** `staff_identity_by_email(email)` and `platform_admin_id_by_email(email)` are the only way past RLS before a tenant is known. They take an exact email and return only what a session needs. Each pins `search_path` and has `EXECUTE` revoked from PUBLIC and granted only to `app_tenant`. `DATABASE_URL_SYSTEM` stays for the scheduled job and the Meta webhook (spec 01). These are also what `getTenantContext()` calls on each request, so deactivation takes effect on the next one. That also replaces the transaction the dev path uses, keeping a request to two or three round trips.
- **The same email at two restaurants can't happen.** `staff.email` is globally unique (spec 00), and now case-insensitively so, for `platform_admins` too. An email is one person at one restaurant, so sign-in never has to ask which one. Someone who works at two restaurants needs two addresses. An email can be both staff and a platform admin: they sign in to each separately.
- **Better Auth's tables** (`staff_auth_*`, `admin_auth_*`) have RLS with the reverse of the tenant policy: rows are visible only when no tenant is set. Better Auth runs as `app_tenant` outside any tenant; nothing inside `withTenant()` can read or change a credential. This is a boundary against bugs, not against SQL injection, which could clear the setting just as it could change `app.restaurant_id`.
- **What's stored.** Magic-link tokens and codes are stored hashed. Session tokens are stored raw, because Better Auth has no option otherwise, but the cookie also carries an HMAC made with `AUTH_SECRET`, so reading the table isn't enough to forge one. There is no password column, and Google's tokens aren't kept: Google is only asked who someone is. That means turning off Better Auth's schema check, which insists on those columns.
- **Separate sessions.** `/api/auth/staff/*` and `/api/auth/admin/*`. A session, link or code from one means nothing to the other. Only the sign-in endpoints we use are exposed; the rest of Better Auth answers 404.
- **Deactivation** ends sessions twice over: `getTenantContext()` refuses on the next request, and a trigger on `staff` deletes the sessions, so reactivating someone can't revive a forgotten tablet. Changing a staff email ends their sessions too.
- **CSRF.** Spec 01 requires SameSite=Lax. `src/proxy.ts` also refuses writes under `/api` whose `Origin` isn't this host. It costs one header comparison, covers every route with no caller changes, and catches what Lax doesn't: sibling subdomains are same-site, and this product serves files from a custom subdomain. A request with no `Origin` is let through, because browsers always send one on these requests and the Meta webhook never does.
- **Idle expiry.** Better Auth moves a session's expiry in the database as it's used, at most once a day, but a page can't set cookies, so `src/proxy.ts` re-sends the cookie with a fresh 30 days on staff paths.
- **The ceiling on codes.** Better Auth's limits don't stop a patient guesser: its 3 wrong tries are per code, every new code resets them, and its 3-a-minute limit is per IP. So each email gets **20 code attempts per 24 hours**, per session type. Sending a code spends one and trying one spends one, up front, so parallel guesses can't slip past. The window starts at the first attempt and refused attempts don't extend it. A code that works clears the count. Past the ceiling the send and sign-in endpoints answer 429 `sign_in_codes_paused`, and the form points at the other ways in. Magic links and Google aren't touched. **Why 20:** one send plus its 3 guesses costs 4, so an attacker gets 15 guesses a day against 1,000,000 codes, however many IPs they own. That's about 0.045% a month and 0.5% a year against one named person, down from about 14% a month from one IP and even odds in 4 hours from 1,000. Staff sign in about once a month, because sessions last 30 days, so 20 leaves room for typos and lost emails. The cost: anyone can pause codes for an email for a day with 20 requests, which is why the link and Google must stay outside it. Everyone is counted the same whether they're known or not, so a refusal says nothing about who works where, and the tables hold every address tried, as `*_auth_verification` already does. **Where:** `staff_auth_code_limit` and `admin_auth_code_limit`, because memory would be per-instance on Vercel, and not `*_auth_rate_limit`, which Better Auth prunes down to its own longest window of about a minute. It runs in every environment, unlike the per-IP limiter, so tests exercise it. To lift a lockout, delete the email's row.
- **Sign-ins aren't audited.** Spec 01's audit list doesn't include them.

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

### D-09: Email provider for sign-in — **proposed, not yet confirmed by Kudzai**
Proposed: **Resend**, for magic links and sign-in codes. Safe to build on, and to be confirmed before going live.
- One API key and one HTTP call, so no SDK. The free tier (around 3,000 emails a month, to be checked at sign-up) covers the pilot, because sign-in emails only go to staff.
- Alternatives: Postmark has the strongest reputation for delivery but little free allowance. Amazon SES is the cheapest at volume but needs an AWS account and a sandbox exit. Either is a new `EmailSender` in `src/lib/auth/email.ts` and nothing else.
- Going live needs a Resend account, a sending domain verified in DNS (which waits on the product name, D-08), and `RESEND_API_KEY` and `EMAIL_FROM` set. Delivery to the inboxes staff really use hasn't been tested.

### D-08: Product name and plan pricing
The repo is named `restaurant-platform` as a working name. Pricing is undefined: the "standard plan" soft limit needs a plan to attach to. Per S-26, the soft limit counts **owner** logins only; staff logins are unlimited. Until plans exist, the app treats the standard plan as the only one and uses spec 01's number, one owner login, for every restaurant (`OWNER_LOGIN_SOFT_LIMIT`).
