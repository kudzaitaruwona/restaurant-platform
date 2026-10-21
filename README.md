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
cp .env.example .env.local   # fill in values
npm run dev
```

Open http://localhost:3000.
