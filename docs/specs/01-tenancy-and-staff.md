# 01 · Tenancy, Staff and Platform Admin

**Phase 1.** Everything else depends on this.

## Goal
Each restaurant is a fully isolated tenant. Staff log in to manage their restaurant. Kudzai (platform admin) can create restaurants and work inside any of them to hand-onboard the first venues.

## Users

| Who | Auth | Can do |
|-----|------|--------|
| Customer | None (anonymous) | View the menu, book, and (phase 6) order |
| Owner | Magic link, email code, or Google (S-27) | Everything for their own restaurant (S-26) |
| Staff | Magic link, email code, or Google (S-27) | Day-to-day service for their own restaurant: sold-out toggle, booking day-view actions, kitchen statuses, mark delivered, clear table, void and force-close (S-26) |
| Platform admin | Magic link, email code, or Google (S-27), separate table | Create restaurants and staff accounts, and act inside any restaurant ("impersonate") with every action audited |

## Decided
- Customers never have accounts. Orders attach to a table session, and bookings attach to a name and phone number.
- **Roles (S-26, supersedes S-16):** `staff.role` is `owner` or `staff`. The first staff record created for a restaurant is its owner. The database guarantees every restaurant always has at least one active owner, so the last owner can't be deactivated or demoted.
- **Owner only:** menu, categories, prices and specials; the exchange rate; staff management (add, deactivate, change role); tables and QR regeneration; booking settings and closures; restaurant settings; the booking success metrics on the dashboard *(proposed, S-34: staff don't see them)*.
- "Owner only: menu" means managing it (a clarification of S-26, not a new rule). Staff see the item list read-only, with the sold-out toggle.
- **Owner and staff:** the sold-out toggle, every booking day-view action, kitchen statuses, mark delivered, clear table, and (phase 6) void and force-close with a required, audited reason.
- Role checks live in the app layer (`requireOwner(ctx)`). RLS stays tenant-only.
- Soft limit: one **owner** login on the standard plan; staff logins are unlimited. Show a notice instead of blocking. Enforce it only once pricing exists (D-08).
- Every protected action needs a tenant context (see "Tenant context and deferred auth").

## Requirements

### Tenant context and deferred auth (decided, S-25)
- `getTenantContext()` is the only source of tenant identity. It returns `{ restaurantId, staffId, role }`, and refuses inactive staff. For a platform admin inside a restaurant, `staffId` is the shadow row and the context also carries `platformAdminId`, which is what gets audited (S-29).
- `withTenant(ctx, fn)` runs `fn` in a transaction that first sets `app.restaurant_id`. Every tenant query goes through it.
- Until real login ships, `DEV_AUTH_BYPASS` makes `getTenantContext()` return a seeded identity. The seed has two restaurants, each with one owner and one staff member, and a dev-only switcher swaps between them.
- **The app refuses to start if `DEV_AUTH_BYPASS` is set in production**, with a test.
- Real login (Better Auth, below) replaces the bypass inside `getTenantContext()` only. No caller changes. It must ship before the first real venue is onboarded.

### Tenant isolation
- **Staff routes:** every query is scoped by `restaurant_id`, taken from the tenant context and never from a request parameter.
- **Public routes** (`/m/{menu_token}`, `/t/{qr_token}` and its ordering endpoints `POST /api/t/{qr_token}/session` and `POST /api/t/{qr_token}/orders` (S-40), `/r/{slug}/book`, `/b/{manage_token}`): there's no session, so the server resolves the tenant by looking up the token or slug. It then sets `app.restaurant_id` and runs every further query under RLS. The token is the only tenant input these routes accept. The lookup is a `SECURITY DEFINER` function per token type that returns only the restaurant's id (S-31).
- **Sign-in** has no tenant yet either. It finds staff by email through a `SECURITY DEFINER` function that returns only what a session needs (S-30).
- **Admin routes:** a platform admin works across tenants, so three routes take the restaurant ID from the URL, the only exceptions to taking it from the session (S-28). `POST /api/admin/restaurants/[restaurantId]/owner` passes it only to `platform_create_first_owner`, which refuses a restaurant that already has staff. `POST /api/admin/restaurants/[restaurantId]/enter` passes it only to `platform_enter_restaurant`, and from then on the ID comes from the session. `POST /api/admin/restaurants/[restaurantId]/qr-codes-printed` passes it only to `platform_set_qr_codes_printed` (S-33). All three sit behind `getPlatformAdminContext()`.
- **The admin path has its own database login,** `app_admin` (`DATABASE_URL_ADMIN`), which only the admin seam loads. Only it can run the `platform_*` functions or touch `admin_auth_*`. `app_tenant` can do neither, whatever it does to `app.restaurant_id` (S-28).
- **Staff sign-in has its own database login,** `app_staff_auth` (`DATABASE_URL_STAFF_AUTH`), which only sign-in loads. Only it can touch `staff_auth_*`, where a magic link is only a row, or run `staff_identity_by_email`. `app_tenant` can do neither, whatever it does to `app.restaurant_id` (S-28, S-30).
- **System routes** (the scheduled job and the Meta webhook, spec 05) work across all tenants. They use a separate database role with `BYPASSRLS`, whose credentials only those two route handlers load. They must still filter by `restaurant_id` explicitly whenever they act on one booking.
- Postgres RLS policies on every tenant table use `current_setting('app.restaurant_id')`, set per transaction.
- Composite foreign keys (see spec 00) are the backstop.
- **Test:** an automated test logs in as restaurant A and attempts reads and writes against B's IDs on every route. Each must fail.
- **Test:** every owner-only route returns 403 for a staff context. This lives in the same harness as the cross-tenant test.

### Staff auth (implemented last, per S-25)
- Passwordless sign-in (S-27): a magic link, an email one-time code, or Sign in with Google. No passwords are stored, so there is no password reset.
- Sign-in only succeeds for an email that already belongs to an active staff record (or a platform admin). There is no self sign-up, including through Google.
- Session cookie: httpOnly, secure, SameSite=Lax. Sessions expire after 30 days idle *(proposed)*, because restaurant tablets stay logged in.
- Deactivating a staff member (`active = false`) kills their sessions immediately.
- How it's built, including the lookup before a tenant exists, where Better Auth's tables sit and the Origin check on writes: S-30. Email provider: D-09 *(proposed)*.

### Platform admin and onboarding
- Admin screen: create a restaurant (name, slug, timezone, currency mode), then create its first staff record, who is its owner (S-26).
- The admin screen also shows each restaurant's booking success metrics (spec 04) without entering it. This is a cross-tenant read, through `platform_list_booking_metrics`, and it isn't audited, like other reads *(proposed, S-34)*.
- "Enter restaurant" switches the admin into that tenant's staff UI, with a persistent banner reading "Acting as admin in {restaurant}".
- A restaurant can be entered before it has an owner. Its first staff record is still its owner (S-26), so until there is one the staff screen adds only an owner.
- Entering a restaurant for the first time creates a shadow `staff` row (`kind = platform_admin`, `role = owner`, which can't log in) so the admin's actions satisfy the `→ staff` foreign keys (spec 00). There is one per restaurant, however many first entries race, and Postgres enforces that and its shape, including that the row is always active *(proposed)* (S-28). The shadow row passes owner permission checks but is excluded from the soft-limit count and the last-owner rule (S-26), and no staff screen or route shows it.
- The entered restaurant is held against the admin's session in Postgres, never in anything the browser can edit. Leaving, signing out or the session ending drops the admin out of the tenant (S-28).
- In development, the dev switcher also offers a platform-admin identity.
- Every admin action inside a tenant is written to `audit_log` with `actor_type = platform_admin`, including writes that aren't on the audit list below when staff make them, and so is each entry and leaving. Going straight to another restaurant and signing out inside one both count as leaving. A session expiring on its own isn't audited, because no one acted, and reads aren't audited *(proposed)* (S-28).
- Onboarding checklist per restaurant, shown to the platform admin only on `/admin`, never to owners or staff (S-33): menu entered, photos, exchange rate set, tables added, QR codes printed, booking hours set, and booking enabled. Every item except "QR codes printed" is derived from the restaurant's data. "QR codes printed" is a manual tick that persists.
  - *(proposed)* The derivations are: a live menu item; a live item with a photo; any exchange rate; a live table; any service period; `booking_settings.enabled`. Each tick or untick is audited, and a repeat tick isn't.
  - *(proposed)* The derivation ignores `currency_mode`: "exchange rate set" is true once any rate row exists. Nothing stops a `usd_only` owner saving a rate (`setExchangeRate`, `POST /api/menu/exchange-rate` and the rate form have no currency-mode check), and a restaurant switched from `both` keeps its rates. So a `usd_only` restaurant that has never saved a rate, which it doesn't need, stays undone and has to enter one to finish its checklist. The right rule for that case is still to be decided.

### Restaurant settings and staff management (owner only)
- Restaurant settings: name, `contact_phone`, Wi-Fi details, `currency_mode`, timezone.
- Staff management: list staff, add a staff member or owner, deactivate, change role. Show the soft-limit notice when adding a second owner; don't block.

### Audit log
Write an entry for: exchange rate changes, staff created, deactivated or role-changed, QR regeneration, booking cancellations and moves by staff, and (phase 6) force-close, void, reject an order (S-36) and reopen.
- *(proposed, S-40)* every order item status change, kitchen moves and mark delivered (`order_item.status`, from and to)
- *(proposed, #73)* a void as `order_item.void` per voided item (its order, the status it left and the reason), and a reject as `order.reject` (the reason and the items it voided) besides each item's `order_item.void`. An entered platform admin is recorded as one (S-29); the item's `voided_by` is their shadow staff row.
- *(proposed, #74)* force-close as `session.force_close` on the session (the reason and the items it voided), besides each item's `order_item.void`. Clear table isn't on the list, so a staff member's isn't audited; an entered platform admin's is, as `session.clear`, like every admin write (S-28).
- *(proposed, #77)* dismissing a table's "Call a waiter" (`table_session.waiter_dismiss`, on the session), only when a call was pending; a dismissal with nothing pending writes no entry.

## Stack (decided, D-07)
- Next.js App Router, TypeScript, Tailwind, shadcn/ui, deployed on Vercel
- Neon Postgres with Drizzle ORM, over Neon's WebSocket `Pool` driver (interactive transactions for `set_config` and `SAVEPOINT`s). Drizzle supports partial indexes and raw SQL for the exclusion constraint and triggers.
- Cloudflare R2 for photos, on a custom domain, behind an `uploadImage` / `deleteImage` / `getUrl` interface
- Better Auth for staff sessions, with two separate session types for staff and platform admin. Implemented last (S-25).
- One exception: the public menu page is a Route Handler with no React, Tailwind or shadcn/ui (S-32). *(Proposed, for Kudzai to confirm: S-32 in detail.)* A guest's manage page `/b/{manage_token}` is a second one, built the same way.

The audit log has no viewer in v1. It is database-only.

## Out of scope (v1)
- Per-staff roles and permissions
- Customer accounts and login
- Self-serve restaurant sign-up. Kudzai creates every tenant himself.

## Acceptance
- [ ] A staff member from restaurant A gets a 404 or 403 on every resource belonging to restaurant B (automated test).
- [ ] A staff-role context gets a 403 on every owner-only route (automated test).
  - The 403 is the HTTP status on route handlers. An owner-only page streams, so it answers 200 with a refusal, no data and `noindex` (S-30).
- [ ] The last active owner of a restaurant can't be deactivated or demoted (database test).
- [ ] The app refuses to start in production with `DEV_AUTH_BYPASS` set (automated test).
- [ ] The platform admin can create a restaurant, create a staff login, and enter the restaurant, and an audit entry is written.
- [ ] Deactivating a staff member logs them out on their next request.
