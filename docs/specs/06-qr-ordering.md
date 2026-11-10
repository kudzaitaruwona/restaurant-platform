# 06 · QR Table Ordering and Sessions

**Phase 6.** D-01, the fake remote orders problem, is settled: the QR token alone lets a customer order, and staff reject or void suspicious orders (S-36 in `docs/decisions.md`). Everything in this spec is decided, except items marked *proposed*. The proposed items are built as written and stay marked proposed (S-36).

## Goal
Customers at a table scan, order, and track their food without waiting to flag a waiter. This runs alongside waiters, not instead of them. The restaurant keeps taking payment on its own swipe machine.

## Validation note
Unlike bookings, **QR ordering has no demand evidence yet.** Test it in person with owners this summer before investing past this spec.

## Decided

### Sessions
- A session belongs to a table. **Only one session can be open per table**, and the table is locked to it.
- The first scan of a table with no open session opens one. Later scans **join** the open session, which covers latecomers. Nobody approves a session, and no code is typed (S-36).
- A session closes on any of several independent triggers:
  - **Staff "clear table"** (v1)
  - **Idle expiry:** 90 minutes with no activity (v1). Activity means scans, orders, item status changes, and reopen. Delivering food counts, so a table that is eating isn't treated as idle.
  - **Force-close** by staff (v1)
  - **In-app payment** (reserved, needs a payment rail, not v1)
  - **POS terminal payment** (reserved, needs POS integration, not v1)
- **Undelivered items block closing.** Every item must be `delivered` or `voided`. Delivering the last item never closes the session by itself.
- **Force-close:** staff void the outstanding items with a logged reason, then close.
- **Reopen:** staff only, within 15 minutes of closing, and only if no session has opened on that table since this one closed, even one that has itself closed again. Reopening resets `last_activity_at`. After that window, a scan starts a fresh session.
- Idle expiry skips sessions that still have undelivered items, because the gate would reject the close. Those sessions are flagged in the staff UI instead.

### Orders
- Customers enter **only a name** ("Name for the waiter"). It must not be empty, and anything else is accepted. The name is remembered on that phone for the session. *(Proposed, S-40: up to 100 characters, like a booking's guest name, as a CHECK in Postgres. The remembered name, the "Pay at the table" line and the note input landed in ticket #69, ahead of #70.)*
- Each order line **freezes its prices** (USD, ZiG, and whether the ZiG price was fixed or calculated), plus the exchange rate used.
- Status is tracked **per item**: placed → cooking → done → delivered, with `voided` for cancellations.
- Each item can have a note ("no onions"). *(Proposed, S-40: a note is up to 200 characters, and a quantity is 1 to 20, both as CHECKs in Postgres.)*
- If an item has an active special, the line records `special_id`.
- Prices are worked out on the server, from the database, in the order's own transaction, with the same rules the menu shows (spec 00 › Menu and pricing, specials included). The request carries only the item, quantity, note and name. A currency that can't be worked out yet (no rate) is stored null, as the menu shows it. (ticket #69)
- Only an item a customer could order now can be ordered: not archived, not sold out, and a bundle only inside its special's window. Anything else is refused and nothing is written. (ticket #69)
- *(Proposed, S-40)* **Order rate limit:** at most 10 orders per table session in any 5 minutes. Past it the order is refused (429) and nothing is written. A photographed code could otherwise flood a kitchen.
- *(Proposed, S-40)* **A stale tab can't order into a new party's session.** The page sends back the session it joined; if that is no longer the table's open session, the order is refused (409) and the page joins the table's session again before the customer retries.

### Access
- Customers stay anonymous, and orders attach to the session.
- Staff login is required for: clear table, force-close, void, reject, reopen, and every kitchen status change.

## Remote orders (D-01, settled as S-36)
Someone could photograph a table's QR code and order from anywhere. v1 accepts that risk rather than put a step in front of every party.
- The QR token alone opens or joins the table's session, and orders go straight to the kitchen. There is no staff approval, no per-table code and no Wi-Fi, IP or location check.
- Staff see every order as it arrives, with its table and customer name, on the kitchen board (spec 07) and the floor view.
- **Reject an order:** staff void every item of the order that hasn't been delivered, with one required reason. *(Proposed: a delivered item was carried to a real table, so it stays.)* The order leaves the kitchen board.
- **Void an item:** staff void one item, with a required reason.
- Both record the staff member and reason on each item (`voided_by`, `void_reason`), are audited (spec 01), and can be done from the floor view or the kitchen view by owner or staff (S-26).
- Regenerating the table's token (spec 03) stops a photographed code for good.
- `table_sessions.approved_at` is unused in v1 and stays in the data model, so staff approval can still be added later without a schema change.

## Customer flow `/t/{qr_token}`
1. Menu (the same page as spec 02) with "Add" buttons and a cart
2. Cart → name → **Place order**
3. **Order tracker**, a live view of every item in the session with its status. This is shared, so everyone at the table sees everything.
4. "Call a waiter" link *(proposed)*: sends a flag to the staff view, with no chat
5. No payment step. "Pay at the table with your waiter as usual."

The page must keep the spec 02 performance budget. The cart and tracker are the only client-side JavaScript. `/t/{qr_token}` stays the hand-written Route Handler that serves the menu (S-32), and ordering adds one small standalone script to it for the cart, the name and the tracker. *(Proposed: the menu HTML stays cached; the script talks to uncached endpoints of its own.)* `/m/{menu_token}` gets no script and never takes an order (spec 03).

*(Proposed, S-40, ticket #69.)* How that is built:
- The script is inline in the page, so the page is still one response and the budget test measures all of it. It reads the token from the address; the page carries no session data.
- On load it scans: `POST /api/t/{qr_token}/session` opens the table's session or joins the open one, and bumps `last_activity_at`. Only then does it show the Add buttons, which are in the page but hidden, so without JavaScript, or with a code that no longer works, the page is the plain menu.
- An order is `POST /api/t/{qr_token}/orders` with the item, quantity, note and name, plus the session the page joined. The order goes into the session found by the token, never by that id, which is only compared with it.
- Both endpoints are uncached (`no-store`), live under `/api` because the proxy refuses every method but GET and HEAD under `/t/`, and don't load sign-in.

## Staff: floor view
- A grid of tables showing status (free, open, flagged), time open, and item counts by status.
- Table detail: every order and item, plus mark delivered, void (with a reason), reject an order (with a reason, S-36), clear table, force-close, and reopen (within the window).
- Idle sessions that are blocked by undelivered items are shown as flagged.

## Out of scope (v1)
- In-app payment and splitting bills
- POS integration
- Item modifiers and options
- Printed kitchen tickets
- Receipts by WhatsApp or email (the opt-in `customers` table comes later)

## Acceptance
- [ ] Two phones scanning a free table at the same moment end up in the same session (enforced by the partial unique index).
- [ ] A session with an undelivered item can't close by any path except force-close.
- [ ] Force-close voids the outstanding items with the staff member and reason recorded.
- [ ] Reopen works at 14 minutes and is refused at 16 minutes. It is also refused if a new party has opened the table since, even if that party's session has already closed.
- [ ] A reopened session is not closed by idle expiry on the next job run.
- [ ] Changing a menu price after an order doesn't change that order's lines.
- [ ] Idle expiry closes a fully delivered session at 90 minutes of inactivity, not 90 minutes since it opened.
- [ ] A staff reject voids every item of the order (undelivered items only, *proposed*, see S-36), recorded with the staff member and reason, and the order leaves the kitchen board (S-36). This replaces "a remote order can't reach the kitchen", which no longer fits D-01's decision: a remote order does reach it.
