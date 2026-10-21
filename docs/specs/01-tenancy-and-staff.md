# 01 · Tenancy, Staff and Platform Admin

**Phase 1.** Everything else depends on this.

## Goal
Each restaurant is a fully isolated tenant. Staff log in to manage their restaurant. Kudzai (platform admin) can create restaurants and work inside any of them to hand-onboard the first venues.

## Users

| Who | Auth | Can do |
|-----|------|--------|
| Customer | None (anonymous) | View the menu, book, and (phase 6) order |
| Staff | Email + password | Everything for their own restaurant |
| Platform admin | Email + password, separate table | Create restaurants and staff accounts, and act inside any restaurant ("impersonate") with every action audited |

## Decided
- Customers never have accounts. Orders attach to a table session, and bookings attach to a name and phone number.
- Multiple staff logins per restaurant, all with the same access. `role` exists with one value (`admin`).
- Soft limit: one staff login on the standard plan. Show a notice instead of blocking. Enforce it only once pricing exists (D-08).
- Protected actions need a staff session: editing the menu and prices, changing the exchange rate, managing tables and regenerating QR codes, managing bookings, and (phase 6) clearing, force-closing, voiding and reopening.

## Requirements

### Tenant isolation
- **Staff routes:** every query is scoped by `restaurant_id`, taken from the authenticated session and never from a request parameter.
- **Public routes** (`/m/{menu_token}`, `/t/{qr_token}`, `/r/{slug}/book`, `/b/{manage_token}`): there's no session, so the server resolves the tenant by looking up the token or slug. It then sets `app.restaurant_id` and runs every further query under RLS. The token is the only tenant input these routes accept.
- **System routes** (the scheduled job and the Meta webhook, spec 05) work across all tenants. They use a separate database role with `BYPASSRLS`, whose credentials only those two route handlers load. They must still filter by `restaurant_id` explicitly whenever they act on one booking.
- Postgres RLS policies on every tenant table use `current_setting('app.restaurant_id')`, set per transaction.
- Composite foreign keys (see spec 00) are the backstop.
- **Test:** an automated test logs in as restaurant A and attempts reads and writes against B's IDs on every route. Each must fail.

### Staff auth
- Email and password login. Passwords are hashed with argon2id or bcrypt (whichever the auth library supports).
- Session cookie: httpOnly, secure, SameSite=Lax. Sessions expire after 30 days idle *(proposed)*, because restaurant tablets stay logged in.
- Password reset by email link.
- Deactivating a staff member (`active = false`) kills their sessions immediately.

### Platform admin and onboarding
- Admin screen: create a restaurant (name, slug, timezone, currency mode), then create its first staff login.
- "Enter restaurant" switches the admin into that tenant's staff UI, with a persistent banner reading "Acting as admin in {restaurant}".
- Entering a restaurant for the first time creates a shadow `staff` row (`kind = platform_admin`, which can't log in) so the admin's actions satisfy the `→ staff` foreign keys (spec 00).
- Every admin action inside a tenant is written to `audit_log` with `actor_type = platform_admin`.
- Onboarding checklist per restaurant: menu entered, photos, exchange rate set, tables added, QR codes printed, booking hours set, and booking enabled.

### Audit log
Write an entry for: exchange rate changes, staff created or deactivated, QR regeneration, booking cancellations and moves by staff, and (phase 6) force-close, void and reopen.

## Stack (proposed, D-07)
- Next.js App Router, TypeScript, Tailwind, shadcn/ui, deployed on Vercel
- Neon Postgres with Drizzle ORM. Drizzle supports partial indexes and raw SQL for the exclusion constraint and triggers.
- Better Auth for staff sessions, with two separate session types for staff and platform admin

## Out of scope (v1)
- Per-staff roles and permissions
- Customer accounts and login
- Self-serve restaurant sign-up. Kudzai creates every tenant himself.

## Acceptance
- [ ] A staff member from restaurant A gets a 404 or 403 on every resource belonging to restaurant B (automated test).
- [ ] The platform admin can create a restaurant, create a staff login, and enter the restaurant, and an audit entry is written.
- [ ] Deactivating a staff member logs them out on their next request.
