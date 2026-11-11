# restaurant-platform

A multi-tenant platform for sit-down restaurants in Zimbabwe. It covers the menu, autonomous bookings with WhatsApp reminders, and (later) QR ordering at the table.

> Working name. See D-08 in `docs/decisions.md`.

## Specs

Start at **[docs/README.md](docs/README.md)**. It has the spec index, build order and product principles. Decisions, both settled and open, are in [docs/decisions.md](docs/decisions.md).

| Phase | Feature | Spec |
|-------|---------|------|
| 1 | Tenancy, staff, platform admin | [01](docs/specs/01-tenancy-and-staff.md) |
| 2 | Menu and public menu page | [02](docs/specs/02-menu.md) |
| 3 | Tables and QR codes | [03](docs/specs/03-tables-and-qr.md) |
| 4 | Autonomous bookings | [04](docs/specs/04-bookings.md) |
| 5 | WhatsApp booking notifications | [05](docs/specs/05-booking-notifications.md) |
| 6 | QR ordering and kitchen view | [06](docs/specs/06-qr-ordering.md), [07](docs/specs/07-kitchen-view.md) |

The shared schema is in [docs/specs/00-data-model.md](docs/specs/00-data-model.md).

## Stack

Next.js (App Router) · TypeScript · Tailwind · shadcn/ui · Postgres (Neon, proposed) · Vercel

The public menu page is the one exception: a Route Handler with no React, Tailwind or shadcn/ui (S-32).

## Design system

One visual system for every screen (S-41): black and white, a green accent for positive states and focus, an amber accent for "a person needs to look", and red for destructive only. Dark mode follows the system.

- **Tokens** are CSS variables in `src/app/globals.css`, exposed to Tailwind by role: `bg-page`, `bg-surface`, `bg-surface-2`, `border-line`, `text-ink`, `text-ink-2`, `bg-brand` / `text-brand-ink` (primary actions), `bg-brand-soft`, `text-accent` / `bg-accent-soft`, `bg-attention` / `bg-attention-soft` / `text-attention-ink`, `bg-danger` / `bg-danger-soft`, `bg-scrim`, `shadow-float`. Type: `text-caption` (13), `text-body` (15), `text-lead` (17), `text-title` (20), `text-heading` (24), `text-display` (32), and `tabular-nums` for times, counts and prices. Shape: `rounded-card` (14px), `rounded-control` (10px), `rounded-full` for chips. The shadcn names (`bg-primary`, `text-muted-foreground`, ...) map onto the same palette; note that `accent` is the green. Use `cn` from `@/lib/utils`, which knows these names.
- **Dark on request:** a page that should be dark whatever the system says renders an element with `data-page-theme="dark"`; the whole shell follows, and so does `dark:`. The kitchen board does this.
- **Components** in `src/components/ui`: `Button` and `buttonVariants`, `IconButton`, `StatusPill`, `Chip` and `ChoiceChip`, `Notice`, `Card`, `Input` / `Select` / `Textarea` / `Field` (and `inputClassName`), `Stepper`, `PageHeader`, `ConfirmDialog`, and `RowMenu` with `RowMenuItem`, `RowMenuSeparator` and `RowMenuLabel`. `ActionForm` (`src/app/dashboard/action-form.tsx`) asks its `confirmation` in a `ConfirmDialog`, never the browser's `confirm()`.
- **The staff shell** is `src/app/dashboard/layout.tsx` with `src/app/dashboard/shell`: the acting-as-admin bar, the navigation rail (a top bar and drawer on phones; `StaffTopBarAction` puts a page's main action in that bar) and the page, padded. The navigation and who sees what is `shell/nav.ts`.
- **Guest pages** (`/t`, `/m`, `/b`, hand-written, S-32) use `guestThemeCss` from `src/lib/guest-theme.ts`: the same tokens and the shared guest primitives (`.btn`, `.pill`, `.notice`, `.chip`, `.input`, `.card`, `.sheet`) in a few KB, with no webfont. A test keeps its tokens equal to `globals.css`.

## Development

```bash
npm install
cp .env.example .env.local   # fill in values; the "local" hints match docker-compose.yml
npm run db:up                # Postgres 17 on :5499 and Neon's wsproxy on :5498
npm run db:migrate           # also lets the app, admin, staff sign-in and system (scheduled job) roles log in, and refuses to run without `DATABASE_URL_SYSTEM`
npm run db:seed              # restaurants A and B and the platform admin, for DEV_AUTH_BYPASS
npm run dev
```

Open http://localhost:3000, or http://localhost:3000/dashboard for the staff side. With `DEV_AUTH_BYPASS` set, the dev switcher on that page swaps between the five seeded identities: an owner and a staff member in each restaurant, and the platform admin, who lands on http://localhost:3000/admin. Owners also get `/dashboard/settings` and `/dashboard/staff`.

With `DEV_AUTH_BYPASS` blank, sign in for real at http://localhost:3000/login (platform admin: `/login/admin`) with a seeded email such as `a-owner@dev.example.test`. This needs `AUTH_SECRET`. With `RESEND_API_KEY` blank, the link or code is printed to the server console. Google needs its own client.

The app reaches Postgres only through Neon's WebSocket `Pool` driver (D-07). Against a plain local Postgres that needs Neon's wsproxy, which `NEON_WS_PROXY` points at. Leave `NEON_WS_PROXY` unset against Neon.

| Command | What it does |
|---------|--------------|
| `npm run lint` | ESLint, including the photo-storage and database import boundaries |
| `npm run typecheck` | Route type generation plus `tsc --noEmit` |
| `npm run test:unit` | Unit tests (no database) |
| `npm run test:integration` | Integration tests against a real Postgres, migrated and seeded first: `TEST_DATABASE_URL` as the owner, `TEST_DATABASE_URL_APP` as `app_tenant`, `TEST_DATABASE_URL_ADMIN` as `app_admin`, `TEST_DATABASE_URL_STAFF_AUTH` as `app_staff_auth`, `TEST_DATABASE_URL_SYSTEM` as `app_system` |
| `npm test` | Both test projects |
| `npm run test:production` | The public pages' cache, against `next start` on the last `npm run build` and the same Postgres as the integration tests |
| `npm run db:generate` | Writes the next migration in `db/migrations` from `src/db/schema.ts` (`-- --custom --name x` for hand-written SQL) |
| `npm run db:migrate` | Applies pending migrations to `DATABASE_URL_UNPOOLED`, then sets the `app_tenant` password from `DATABASE_URL`, the `app_admin` password from `DATABASE_URL_ADMIN` and the `app_staff_auth` password from `DATABASE_URL_STAFF_AUTH` and the `app_system` password from `DATABASE_URL_SYSTEM`, and fails if RLS wouldn't apply to the first three, or if `app_system` isn't `BYPASSRLS` or has more power than the job needs (`provisionSystemRole`) |
| `npm run db:seed` | Creates the development restaurants and staff (needs `DEV_AUTH_BYPASS`, refuses production) |

### Tenant isolation

All tenant data goes through the seam in `src/lib/tenant`: `getTenantContext()` says who is asking, `requireOwner(ctx)` guards owner-only actions, and `withTenant(ctx, fn)` runs `fn` in a transaction scoped to that restaurant. ESLint keeps `getDb` out of everything else.

A public route has no session, so `resolvePublicToken()` (`src/lib/tenant/public.ts`) turns its token into a tenant for `withTenant()` (S-31). Code on a public route imports `@/lib/tenant/scope`, not `@/lib/tenant`, which loads sign-in; a test fails if it reaches Better Auth (S-32).

There are five database roles. The app connects as `app_tenant` (`DATABASE_URL`), which has no superuser or `BYPASSRLS` and owns no tables, so row-level security applies to it. The admin path connects as `app_admin` (`DATABASE_URL_ADMIN`), and staff sign-in as `app_staff_auth` (`DATABASE_URL_STAFF_AUTH`), each under the same rules and with its own pool (see "Platform admin" and "Sign-in"). The scheduled job connects as `app_system` (`DATABASE_URL_SYSTEM`), the one role with `BYPASSRLS`: it acts across restaurants, so it has only the column grants its tasks need, filters by `restaurant_id` itself, and only its route (`src/app/api/cron/tick`) and the Meta webhook (`src/app/api/webhooks/whatsapp`) may load that URL (S-35). Migrations and the seed run as the role that owns the tables (`DATABASE_URL_UNPOOLED`), which RLS skips. Outside `withTenant()`, `app_tenant` sees no tenant rows at all.

Every restaurant keeps at least one active owner: a trigger on `staff` refuses any change that would remove the last one, for every role (S-26). That includes test cleanup, so a test that needs to remove owners gives them a restaurant of their own and leaves it behind.

Adding a tenant table: give it `restaurant_id`, `UNIQUE (restaurant_id, id)`, composite foreign keys and `tenantPolicy("restaurant_id")` (`src/db/schema.ts`). Adding a route: add it to `routes` in `src/lib/tenant/access.int.test.ts`, to `sessionRoutes` if it takes no id, or to `publicRoutes` if it has no session. A route with no session and no tenant at all, which is secret-protected instead (the scheduled job's `GET /api/cron/tick`), goes in `outsideTheHarness` in the same file, with a comment saying which test covers it. A route that `ActionForm` (`src/app/dashboard/action-form.tsx`) posts to must answer success with `formSaved()` (`src/lib/form-response.ts`), which gives it a 204 and a plain form post a 303; a bare redirect makes the browser fetch and render the page for nothing, and the form reports on that. A route reached only by a plain `<form>` returns the 303 itself, as `src/app/api/staff/[staffId]/route.ts` does. A test fails if a table has no RLS or tenant policy, no `UNIQUE (restaurant_id, id)`, or a foreign key to another tenant table that isn't composite, or if a route isn't listed.

### Public menu page

`/m/{menu_token}` is a Route Handler that writes its own HTML, not a Next.js page, because an App Router page can't leave out the framework's scripts and spec 02's budget can't carry them (S-32). `src/lib/public-menu.ts` has the whole page. It's cached for 5 minutes at most, and anything that changes what it shows calls `revalidateMenu()` (`src/lib/menu-cache.ts`) after committing, so a customer sees a save straight away. Every function in `src/lib/menu.ts` that writes already does. `src/proxy.ts` refuses everything but GET and HEAD here, because Next.js would store the answer as the page.

`npm run test:production` checks all of this against the real cache. It needs `npm run build` first, because the ordinary tests can't run `use cache` or the proxy.

### Platform admin

The platform admin belongs to no restaurant: `getPlatformAdminContext()` (`src/lib/tenant/platform-admin.ts`) says who it is, and `getTenantContext()` answers it with a 403 until it enters one. `/admin` creates restaurants and their first owners through `SECURITY DEFINER` functions, because `app_tenant` can't do either itself. Only that file calls them, and only `app_admin` can: `app_tenant` has no `EXECUTE` on `platform_*` and no privilege on `admin_auth_*`. ESLint and `access.int.test.ts` keep `getAdminDb` to the files listed as `adminSeam` in `eslint.config.mjs`, and `authDatabase`, which hands back that login or staff sign-in's, to `src/lib/auth`. S-28 in `docs/decisions.md` says what stops a tenant identity reaching them and what doesn't. The onboarding checklist for each restaurant is on `/admin` and shown to no one else (S-33): `platform_onboarding_checklist` derives it, and `platform_set_qr_codes_printed` ticks the one manual item and audits it. `/admin` also lists every restaurant's booking success metrics through `platform_list_booking_metrics`, a read across tenants *(proposed, S-34)*. Adding an admin route: add it to `adminRoutes` in `src/lib/tenant/access.int.test.ts`.

"Enter restaurant" on `/admin` puts the session in that tenant's staff UI, under a banner with a way back out. `getTenantContext()` then returns the restaurant's shadow staff row, as an owner, plus `platformAdminId`. The restaurant is held in `admin_auth_entry` against the session, so nothing in the browser chooses it and it ends with the session. Inside a tenant the admin works through `withTenant()` as `app_tenant`, like anyone else.

Every admin action inside a tenant has to reach `audit_log`. `recordAudit` records the admin by itself as long as it's given the whole context, so pass `tenant` along rather than picking fields out of it. A write that isn't on spec 01's audit list calls `recordAdminAction`, which records only an admin. The harness fails a write route that doesn't. A `staff` query must filter on `kind = 'staff'`, or the shadow row shows up as a colleague.

### Sign-in

Staff and the platform admin sign in with a magic link, an emailed code or Google (S-27, S-30). `src/lib/auth` holds Better Auth, with one instance per session type: `/api/auth/staff/*` and `/api/auth/admin/*`. `getTenantContext()` and `getPlatformAdminContext()` read those sessions and check the staff or admin row on every request. Only an existing active staff record or platform admin can get a session, and the lookups go through `SECURITY DEFINER` functions, because RLS hides `staff` before a tenant is known.

Each session type has its own database login: the staff audience connects as `app_staff_auth` (`src/db/staff-auth.ts`) and the admin audience as `app_admin`. `app_tenant` holds no privilege on `staff_auth_*` or `admin_auth_*`, because a magic link is only a row there, and it can't run the lookups either (S-28, S-30). ESLint and `access.int.test.ts` keep `getStaffAuthDb` to `src/lib/auth/database.ts` and `src/lib/auth/identity.ts`.

`src/proxy.ts` refuses cross-site writes under `/api` and keeps session cookies alive. A staff page outside `/dashboard` or `/admin` needs adding to its matcher. It also runs on public pages, but only to refuse methods the cache can't take (S-32).

### Environment

Environment variables are validated with zod when the server starts (`src/instrumentation.ts`, `src/lib/env.ts`). A missing or invalid one makes the server exit with a list of what's wrong. `next build` doesn't validate, so it runs without secrets. `DEV_AUTH_BYPASS` and `NEON_WS_PROXY` are refused in production, and `DATABASE_URL_ADMIN`, `DATABASE_URL_STAFF_AUTH` and the sign-in variables are required there, which includes a local `npm run start`: leave the first two blank and give the rest stand-ins to run a production build on your machine. A build that needs the local database goes through the wsproxy, which production refuses, so start it with `NODE_ENV=test npx next start` and the variables in the shell: the bundle is still the production build, and `.env.local` isn't read.

### Turning on WhatsApp

Booking messages are queued in `notifications` and sent by the scheduled job (spec 05, S-37): a confirmation when a booking is confirmed, a reminder due 3 hours before it starts (skipped if that time has passed), and a cancellation message when the guest or staff cancel it. A failed send that may work later is retried twice, 5 and then 10 minutes on. Until WhatsApp's keys are set, production holds them as `pending`, and development prints each message to the server console instead, but only when the job runs: nothing schedules it locally, so call it by hand with `curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/tick`. Holding is safe: the job re-checks each booking before sending, so a held confirmation or reminder for a booking cancelled since is dropped, not sent.

To turn it on, once Meta has approved the account and the `booking_confirmed`, `booking_reminder` and `booking_cancelled` templates (in language `en`; the first two with a URL button to `{NEXT_PUBLIC_APP_URL}/b/{{1}}`, the cancellation with no button):

1. In the Vercel project's environment variables (Production), set `WHATSAPP_PHONE_NUMBER_ID` (the phone number's ID from Meta's WhatsApp Manager, digits only, not the number) and `WHATSAPP_ACCESS_TOKEN` (a permanent system-user token), then redeploy.
2. The next run of the job, within 5 minutes, sends everything held. Its response lists `notifications` with how many it finished; while holding, its log says how many it is holding and which variable is missing.
3. Point Meta's webhook at the app, so delivery statuses come back. The staff day view shows a warning icon on a booking whose confirmation failed (for example, the number isn't on WhatsApp), so staff can call the guest:
   1. In the same environment variables, set `WHATSAPP_APP_SECRET` (the Meta app's **App secret**, under App settings › Basic) and `WHATSAPP_WEBHOOK_VERIFY_TOKEN` (any long random string you make up, e.g. `openssl rand -hex 32`), then redeploy. Without the secret the webhook refuses every status (401), and without the token Meta can't subscribe (403).
   2. In the Meta app dashboard, WhatsApp › Configuration › Webhook, set the **Callback URL** to `{NEXT_PUBLIC_APP_URL}/api/webhooks/whatsapp` and the **Verify token** to the same string, then **Verify and save**. Meta calls the URL with `GET` and the app answers with Meta's challenge only when the token matches.
   3. Under Webhook fields, subscribe to **`messages`**. That field carries the `sent`, `delivered`, `read` and `failed` statuses.

   Every status Meta posts is checked against `X-Hub-Signature-256` (HMAC-SHA256 of the body under the app secret) before anything is read, and matched to its notification by Meta's message id. Meta retries a status the app didn't take, so statuses refused while the secret was missing arrive once it is set, within Meta's retry window.

