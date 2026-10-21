<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project rules

Specs live in `docs/specs/`, and decisions live in `docs/decisions.md`. Read the relevant spec before building a feature.

- **Tenant isolation is mandatory.** Every tenant table has `restaurant_id`, every FK between tenant tables is composite, and the restaurant ID always comes from the authenticated session, never from request input.
- **Rules that protect seats or money belong in Postgres:** the booking exclusion constraint, the one-open-session index, the closure gate trigger, and frozen order prices. App-level checks only keep the UI honest.
- Anything marked **Decided** in a spec should only change if `docs/decisions.md` is updated in the same change.
- Don't build spec 06 (QR ordering) until decision D-01 in `docs/decisions.md` is resolved.
- All displayed times use `restaurants.timezone` (default `Africa/Harare`), never the server's timezone.
- The public menu page has a performance budget (spec 02). Don't add client-side JS to it without a reason.
