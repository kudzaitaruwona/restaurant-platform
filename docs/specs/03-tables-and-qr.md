# 03 · Tables and QR Codes

**Phase 3.** Tables are shared by bookings (spec 04) and ordering (spec 06).

## Goal
Adding a table gives the restaurant a printable QR code straight away. The codes printed now must keep working when ordering launches, so nobody reprints anything.

## Decided
- A table is a label plus a capacity.
- Adding a table mints a random, permanent `qr_token` and a printable code automatically.
- Staff can regenerate a table's token. The old printed code stops working immediately.
- The generic restaurant QR code (`menu_token`) is menu-view only and never allows ordering.

## Key design point: one URL that changes behaviour with phase
A table QR code encodes `https://{domain}/t/{qr_token}`.

- **Phases 3–5:** `/t/{qr_token}` renders the menu, plus a small "Book again" link to the booking page.
- **Phase 6:** the same URL becomes the ordering entry point.

The token identifies the table on the server. The URL never contains the table label or the restaurant ID.

## Staff: table manager
- List of tables showing label, capacity, bookable toggle, and sort order.
- Add a table (label and capacity). The token is generated on save.
- Edit the label, capacity, or bookable flag. Capacity changes apply to future booking assignments only, and existing bookings keep their table.
- **Archive** a table. If it has future confirmed bookings, the system blocks archiving and lists them so staff can move or cancel them first.
- **Regenerate QR**: confirmation dialog ("The printed code on Table 7 will stop working"), then an audit log entry and a prompt to reprint.
- `bookable = false` keeps a table out of online booking, for walk-in-only or bar tables.

## Print sheet
- One page, `/admin/tables/print`, prints with the browser's print function (no PDF library).
- A4 layout with 2×3 cards per page *(proposed)*. Each card shows the restaurant name, the table label in large type, the QR code (SVG, at least 3cm wide), a short instruction, and the Wi-Fi details if set.
- Options: print all tables, print selected tables, and include the generic menu QR card (for the door or the counter).
- QR codes are generated server-side as SVG with error-correction level M, using the `qrcode` npm package.

## Token rules
- At least 128 bits of randomness, base62-encoded (about 22 characters)
- Unique across the whole platform, so a token on its own identifies the table and the restaurant
- An unknown or regenerated token shows a friendly "This code is out of date — ask staff" page with a link to the restaurant's generic menu if it can be resolved. No 500 error.
- Scans are not logged with any customer data. Phase 6 only bumps the session's `last_activity_at`.

## Out of scope (v1)
- Floor plan or table map editor
- Combining tables (see D-02)
- NFC tags

## Acceptance
- [ ] Adding a table produces a scannable code on the print sheet with no further steps.
- [ ] Regenerating a token invalidates the old code (it shows the out-of-date page) and the new one works.
- [ ] A table with future bookings can't be archived until they're dealt with.
- [ ] The print sheet prints cleanly on A4 from Chrome on Android and desktop.
