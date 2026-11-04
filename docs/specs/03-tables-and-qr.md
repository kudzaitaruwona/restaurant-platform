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
- One page, `/dashboard/tables/print` (staff pages live under `/dashboard/*` *(proposed)*, see D-10), prints with the browser's print function (no PDF library).
- A4 layout with 2×3 cards per page *(proposed)*. Each card shows the restaurant name, the table label in large type, the QR code (SVG, at least 3cm wide), a short instruction, and the Wi-Fi details if set.
- Options: print all tables, print selected tables, and include the generic menu QR card (for the door or the counter).
- The owner can leave the Wi-Fi password off the cards. It prints by default *(proposed)*.
- The Wi-Fi name and password print on lines of their own, in type that steps down to fit. Details too long to fit in full are never cut: the cards say to ask staff, and the sheet tells the owner *(proposed)*.
- QR codes are generated server-side as SVG with error-correction level M, using the `qrcode` npm package.

## Token rules
- At least 128 bits of randomness, base62-encoded (about 22 characters)
- Unique across the whole platform, so a token on its own identifies the table and the restaurant
- An unknown or regenerated token shows a friendly "This code is out of date — ask staff" page with a link to the restaurant's generic menu if it can be resolved. No 500 error.
- An archived table's code is treated the same way: it shows the out-of-date page *(proposed)*. The lookup returns nothing for an archived table, so the generic-menu link can't appear for it. Whether it should is open (#4, #28).
- A regenerated code's old token isn't kept, so it can't be told from an unknown one and its out-of-date page gets no generic-menu link *(proposed, for the owner to confirm)*.
- A label is 1 to 50 characters and a capacity is a whole number from 1 to 100 *(proposed)*. The spec only asks for a unique label and a capacity above 0; the upper limits keep a typo off the print sheet.
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
