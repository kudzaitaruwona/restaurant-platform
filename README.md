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
| 6 | QR ordering and kitchen view (blocked on D-01) | [06](docs/specs/06-qr-ordering.md), [07](docs/specs/07-kitchen-view.md) |

The shared schema is in [docs/specs/00-data-model.md](docs/specs/00-data-model.md).

## Stack

Next.js (App Router) · TypeScript · Tailwind · shadcn/ui · Postgres (Neon, proposed) · Vercel

## Development

```bash
npm install
cp .env.example .env.local   # fill in values; the "local" hints match docker-compose.yml
npm run db:up                # Postgres 17 on :5499 and Neon's wsproxy on :5498
npm run db:migrate           # also lets the app role log in
npm run db:seed              # restaurants A and B and the platform admin, for DEV_AUTH_BYPASS
npm run dev
```

Open http://localhost:3000, or http://localhost:3000/dashboard for the staff side. With `DEV_AUTH_BYPASS` set, the dev switcher on that page swaps between the five seeded identities: an owner and a staff member in each restaurant, and the platform admin, who lands on http://localhost:3000/admin.

The app reaches Postgres only through Neon's WebSocket `Pool` driver (D-07). Against a plain local Postgres that needs Neon's wsproxy, which `NEON_WS_PROXY` points at. Leave `NEON_WS_PROXY` unset against Neon.

| Command | What it does |
|---------|--------------|
| `npm run lint` | ESLint, including the photo-storage and database import boundaries |
| `npm run typecheck` | Route type generation plus `tsc --noEmit` |
| `npm run test:unit` | Unit tests (no database) |
| `npm run test:integration` | Integration tests against a real Postgres, migrated and seeded first: `TEST_DATABASE_URL` as the owner, `TEST_DATABASE_URL_APP` as `app_tenant` |
| `npm test` | Both test projects |
| `npm run db:generate` | Writes the next migration in `db/migrations` from `src/db/schema.ts` (`-- --custom --name x` for hand-written SQL) |
| `npm run db:migrate` | Applies pending migrations to `DATABASE_URL_UNPOOLED`, then sets the `app_tenant` password from `DATABASE_URL` and fails if RLS wouldn't apply to that role |
| `npm run db:seed` | Creates the development restaurants and staff (needs `DEV_AUTH_BYPASS`, refuses production) |

### Tenant isolation

All tenant data goes through the seam in `src/lib/tenant`: `getTenantContext()` says who is asking, `requireOwner(ctx)` guards owner-only actions, and `withTenant(ctx, fn)` runs `fn` in a transaction scoped to that restaurant. ESLint keeps `getDb` out of everything else.

There are two database roles. The app connects as `app_tenant` (`DATABASE_URL`), which has no superuser or `BYPASSRLS` and owns no tables, so row-level security applies to it. Migrations and the seed run as the role that owns the tables (`DATABASE_URL_UNPOOLED`), which RLS skips. Outside `withTenant()`, `app_tenant` sees no tenant rows at all.

Adding a tenant table: give it `restaurant_id`, `UNIQUE (restaurant_id, id)`, composite foreign keys and `tenantPolicy("restaurant_id")` (`src/db/schema.ts`). Adding a route: add it to `routes` in `src/lib/tenant/access.int.test.ts`. A test fails if a table has no RLS or tenant policy, or a route isn't listed. Nothing checks the `UNIQUE` or the composite foreign keys yet, so those are on you and your reviewer.

### Platform admin

The platform admin belongs to no restaurant: `getPlatformAdminContext()` (`src/lib/tenant/platform-admin.ts`) says who it is, and `getTenantContext()` answers it with a 403. `/admin` creates restaurants and their first owners through `SECURITY DEFINER` functions, because `app_tenant` can't do either itself. Only that file calls them. S-28 in `docs/decisions.md` says what stops a tenant identity reaching them and what doesn't. Adding an admin route: add it to `adminRoutes` in `src/lib/tenant/access.int.test.ts`.

### Environment

Environment variables are validated with zod when the server starts (`src/instrumentation.ts`, `src/lib/env.ts`). A missing or invalid one makes the server exit with a list of what's wrong. `next build` doesn't validate, so it runs without secrets. `DEV_AUTH_BYPASS` and `NEON_WS_PROXY` are refused in production, which includes a local `npm run start`: leave both blank to run a production build on your machine.
