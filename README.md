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
npm run db:migrate
npm run dev
```

Open http://localhost:3000.

The app reaches Postgres only through Neon's WebSocket `Pool` driver (D-07). Against a plain local Postgres that needs Neon's wsproxy, which `NEON_WS_PROXY` points at. Leave `NEON_WS_PROXY` unset against Neon.

| Command | What it does |
|---------|--------------|
| `npm run lint` | ESLint, including the photo-storage import boundary |
| `npm run typecheck` | Route type generation plus `tsc --noEmit` |
| `npm run test:unit` | Unit tests (no database) |
| `npm run test:integration` | Integration tests against the real Postgres in `TEST_DATABASE_URL`, migrated first |
| `npm test` | Both test projects |
| `npm run db:generate` | Writes the next migration in `db/migrations` from `src/db/schema.ts` (`-- --custom --name x` for hand-written SQL) |
| `npm run db:migrate` | Applies pending migrations to `DATABASE_URL_UNPOOLED` |

Environment variables are validated with zod when the server starts (`src/instrumentation.ts`, `src/lib/env.ts`). A missing or invalid one stops the server with a list of what's wrong. `next build` doesn't validate, so it runs without secrets.
