# 01 · Tenancy, Staff and Platform Admin

**Phase 1.** Everything else depends on this.

## Goal
Each restaurant is a fully isolated tenant. Staff log in to manage their restaurant. Kudzai (platform admin) can create restaurants and work inside any of them to hand-onboard the first venues.

## Users

| Who | Auth | Can do |
|-----|------|--------|
| Customer | None (anonymous) | View the menu, book, and (phase 6) order |
| Owner | Email + password | Everything for their own restaurant (S-26) |
| Staff | Email + password | Day-to-day service for their own restaurant: sold-out toggle, booking day-view actions, kitchen statuses, mark delivered, clear table, void and force-close (S-26) |
| Platform admin | Email + password, separate table | Create restaurants and staff accounts, and act inside any restaurant ("impersonate") with every action audited |

## Decided
- Customers never have accounts. Orders attach to a table session, and bookings attach to a name and phone number.
- **Roles (S-26, supersedes S-16):** `staff.role` is `owner` or `staff`. The first staff record created for a restaurant is its owner. The database guarantees every restaurant always has at least one active owner, so the last owner can't be deactivated or demoted.
- **Owner only:** menu, categories, prices and specials; the exchange rate; staff management (add, deactivate, change role); tables and QR regeneration; booking settings and closures; restaurant settings.
- **Owner and staff:** the sold-out toggle, every booking day-view action, kitchen statuses, mark delivered, clear table, and (phase 6) void and force-close with a required, audited reason.
- Role checks live in the app layer (`requireOwner(ctx)`). RLS stays tenant-only.
- Soft limit: one **owner** login on the standard plan; staff logins are unlimited. Show a notice instead of blocking. Enforce it only once pricing exists (D-08).
- Every protected action needs a tenant context (see "Tenant context and deferred auth").

## Requirements

### Tenant context and deferred auth (decided, S-25)
- `getTenantContext()` is the only source of tenant identity. It returns `{ restaurantId, staffId, role }`, and refuses inactive staff.
- `withTenant(ctx, fn)` runs `fn` in a transaction that first sets `app.restaurant_id`. Every tenant query goes through it.
- Until real login ships, `DEV_AUTH_BYPASS` makes `getTenantContext()` return a seeded identity. The seed has two restaurants, each with one owner and one staff member, and a dev-only switcher swaps between them.
- **The app refuses to start if `DEV_AUTH_BYPASS` is set in production**, with a test.
- Real login (Better Auth, below) replaces the bypass inside `getTenantContext()` only. No caller changes. It must ship before the first real venue is onboarded.

### Tenant isolation
- **Staff routes:** every query is scoped by `restaurant_id`, taken from the tenant context and never from a request parameter.
- **Public routes** (`/m/{menu_token}`, `/t/{qr_token}`, `/r/{slug}/book`, `/b/{manage_token}`): there's no session, so the server resolves the tenant by looking up the token or slug. It then sets `app.restaurant_id` and runs every further query under RLS. The token is the only tenant input these routes accept.
- **System routes** (the scheduled job and the Meta webhook, spec 05) work across all tenants. They use a separate database role with `BYPASSRLS`, whose credentials only those two route handlers load. They must still filter by `restaurant_id` explicitly whenever they act on one booking.
- Postgres RLS policies on every tenant table use `current_setting('app.restaurant_id')`, set per transaction.
- Composite foreign keys (see spec 00) are the backstop.
- **Test:** an automated test logs in as restaurant A and attempts reads and writes against B's IDs on every route. Each must fail.
- **Test:** every owner-only route returns 403 for a staff context. This lives in the same harness as the cross-tenant test.

### Staff auth (implemented last, per S-25)
- Email and password login. Passwords are hashed with argon2id or bcrypt (whichever the auth library supports).
- Session cookie: httpOnly, secure, SameSite=Lax. Sessions expire after 30 days idle *(proposed)*, because restaurant tablets stay logged in.
- Password reset by email link.
- Deactivating a staff member (`active = false`) kills their sessions immediately.

### Platform admin and onboarding
- Admin screen: create a restaurant (name, slug, timezone, currency mode), then create its first staff record, who is its owner (S-26).
- "Enter restaurant" switches the admin into that tenant's staff UI, with a persistent banner reading "Acting as admin in {restaurant}".
- Entering a restaurant for the first time creates a shadow `staff` row (`kind = platform_admin`, `role = owner`, which can't log in) so the admin's actions satisfy the `→ staff` foreign keys (spec 00). The shadow row passes owner permission checks but is excluded from the soft-limit count and the last-owner rule (S-26).
- In development, the dev switcher also offers a platform-admin identity.
- Every admin action inside a tenant is written to `audit_log` with `actor_type = platform_admin`.
- Onboarding checklist per restaurant: menu entered, photos, exchange rate set, tables added, QR codes printed, booking hours set, and booking enabled.

### Restaurant settings and staff management (owner only)
- Restaurant settings: name, `contact_phone`, Wi-Fi details, `currency_mode`, timezone.
- Staff management: list staff, add a staff member or owner, deactivate, change role. Show the soft-limit notice when adding a second owner; don't block.

### Audit log
Write an entry for: exchange rate changes, staff created, deactivated or role-changed, QR regeneration, booking cancellations and moves by staff, and (phase 6) force-close, void and reopen.

## Stack (decided, D-07)
- Next.js App Router, TypeScript, Tailwind, shadcn/ui, deployed on Vercel
- Neon Postgres with Drizzle ORM, over Neon's WebSocket `Pool` driver (interactive transactions for `set_config` and `SAVEPOINT`s). Drizzle supports partial indexes and raw SQL for the exclusion constraint and triggers.
- Cloudflare R2 for photos, on a custom domain, behind an `uploadImage` / `deleteImage` / `getUrl` interface
- Better Auth for staff sessions, with two separate session types for staff and platform admin. Implemented last (S-25).

The audit log has no viewer in v1. It is database-only.

## Out of scope (v1)
- Per-staff roles and permissions
- Customer accounts and login
- Self-serve restaurant sign-up. Kudzai creates every tenant himself.

## Acceptance
- [ ] A staff member from restaurant A gets a 404 or 403 on every resource belonging to restaurant B (automated test).
- [ ] A staff-role context gets a 403 on every owner-only route (automated test).
- [ ] The last active owner of a restaurant can't be deactivated or demoted (database test).
- [ ] The app refuses to start in production with `DEV_AUTH_BYPASS` set (automated test).
- [ ] The platform admin can create a restaurant, create a staff login, and enter the restaurant, and an audit entry is written.
- [ ] Deactivating a staff member logs them out on their next request.
