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
- *(Proposed, #74)* Clear table and force-close are `POST /api/floor/{tableId}/clear` and `POST /api/floor/{tableId}/force-close` (with `reason`), from the table's detail. Each form names the session the page showed, as a precondition: if the table's open session isn't that one (it has closed, or a new party has sat down), it is a 409 and nothing closes, so an old page can't close the next party's session. Clear table refused by undelivered items is a 409 listing them and pointing to force-close. Force-close also closes a session with nothing outstanding, voiding nothing. *(Proposed, #95)* The force-close form also names the outstanding items it listed (`item`, once each). If the set has changed (an item ordered, delivered or voided since), it is a 409 with the items now outstanding, nothing is voided or closed, and the page refreshes so the dialog lists them. A kitchen move between placed, cooking and done doesn't count: staff saw that item.
- **Reopen:** staff only, within 15 minutes of closing, and only if no session has opened on that table since this one closed, even one that has itself closed again. Reopening resets `last_activity_at`. After that window, a scan starts a fresh session.
- *(Proposed, #76)* Reopen is `POST /api/floor/{tableId}/reopen`, from a free table's detail, naming the closed session it offered. The detail offers the table's latest session, by when it opened, while it closed less than 15 minutes ago, with when it closed and until when it can be reopened, on the restaurant's clock. Postgres refuses a reopen past the window or after a newer party, with a 409 that says which; a session that is no longer closed, or isn't this table's, is a 409 too. A reopen racing a scan of the same table either wins, and the scan joins the reopened session, or loses to the scan's new session and is refused. Audited as `session.reopen` (spec 01).
- Idle expiry skips sessions that still have undelivered items, because the gate would reject the close. Those sessions are flagged in the staff UI instead.
- *(Proposed, #75)* Idle expiry is the scheduled job's last task (S-35), `idleSessionsClosed`: a guarded `UPDATE … WHERE status = 'open' AND last_activity_at <= now − 90 min AND` no line in play, as `app_system`, with `close_reason = idle_expiry`, `closed_by` null and `closed_at` the job's now. It isn't audited. See S-40 in detail.

### Orders
- Customers enter **only a name** ("Name for the waiter"). It must not be empty, and anything else is accepted. The name is remembered on that phone for the session. *(Proposed, S-40: up to 100 characters, like a booking's guest name, as a CHECK in Postgres. The remembered name, the "Pay at the table" line and the note input landed in ticket #69, ahead of #70.)*
- Each order line **freezes its prices** (USD, ZiG, and whether the ZiG price was fixed or calculated), plus the exchange rate used.
- Status is tracked **per item**: placed → cooking → done → delivered, with `voided` for cancellations.
- Each item can have a note ("no onions"). *(Proposed, S-40: a note is up to 200 characters, and a quantity is 1 to 20, both as CHECKs in Postgres.)*
- If an item has an active special, the line records `special_id`.
- Prices are worked out on the server, from the database, in the order's own transaction, with the same rules the menu shows (spec 00 › Menu and pricing, specials included). The request carries only the item, quantity, note and name (and, *proposed*, the session and the submission's id, below). *(Proposed, S-40)* A currency that can't be worked out yet (no rate) is stored null, as the menu shows it. (ticket #69)
- Only an item a customer could order now can be ordered: not archived, not sold out, and a bundle only inside its special's window. Anything else is refused and nothing is written. (ticket #69)
- *(Proposed, S-40)* **Order rate limit:** at most 10 orders per table session in any 5 minutes. Past it the order is refused (429) and nothing is written. A photographed code could otherwise flood a kitchen.
- *(Proposed, S-40)* **A stale tab can't order into a new party's session.** The page sends back the session it joined; if that is no longer the table's open session, the order is refused (409) and the page joins the table's session again before the customer retries.
- *(Proposed, S-40, #84)* **A retry is the same order.** Each submission carries an id the page makes (`request`), kept through retries until it is placed. The same id again, with the same items, quantities and notes, answers the original order (201, the names it was placed with) and writes nothing, whatever has happened since: the session ended, an item sold out, a price changed, or the rate limit reached. The same id with other lines is a 409 (`already_placed`) that says what was placed and keeps the cart. Ordering the same thing again after it was placed is a new submission, so it is a new order.

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
4. "Call a waiter" link *(proposed)*: sends a flag to the staff view, with no chat (`POST /api/t/{qr_token}/waiter`; it opens or joins the table's session like a scan, and is activity). *(Proposed, #97)* What the page shows of it follows the server, through the tracker's poll: while the call is pending, on every phone at the table and after a reload, the button says "Waiter called" and the page says "Your table's call has been sent to the staff."; once staff dismiss it, "The staff have seen your table's call." and the button can be pressed for another; when the session ends, nothing. The page never says a waiter is coming.
5. No payment step. "Pay at the table with your waiter as usual."

The page must keep the spec 02 performance budget. The cart and tracker are the only client-side JavaScript. `/t/{qr_token}` stays the hand-written Route Handler that serves the menu (S-32), and ordering adds one small standalone script to it for the cart, the name and the tracker. *(Proposed: the menu HTML stays cached; the script talks to uncached endpoints of its own.)* `/m/{menu_token}` gets no script and never takes an order (spec 03).

*(Proposed, S-40, ticket #69.)* How that is built:
- The script is inline in the page, so the page is still one response and the budget test measures all of it. It reads the token from the address; the page carries no session data.
- On load it scans: `POST /api/t/{qr_token}/session` opens the table's session or joins the open one, and bumps `last_activity_at`. Only then does it show the Add buttons, which are in the page but hidden, so without JavaScript, or with a code that no longer works, the page is the plain menu. *(Proposed, #98)* A scan that fails to answer (no connection, nothing within 8 seconds, a 5xx, a 408 or 429) is not the end of ordering: the page says "Couldn't reach the table. Trying again" under the header, with a Try again button, and retries by itself 5 times, after 2, 5, 10, 20 and 40 seconds (longer if a 429 sends `Retry-After`, up to 60 seconds). After the fifth it stops and says ordering isn't available right now, leaving the button. Pressing it starts the 5 again. The first scan that works shows the Add buttons and Call a waiter without a reload. Any other 4xx (a code that no longer works, ordering off, an archived table) is final: no retry and no message, the plain menu.
- An order is `POST /api/t/{qr_token}/orders` with the item, quantity, note and name, plus the session the page joined and the submission's id (`request`, #84). The order goes into the session found by the token, never by that id, which is only compared with it.
- The endpoints are uncached (`no-store`), live under `/api` because the proxy refuses every method but GET and HEAD under `/t/`, and don't load sign-in.

*(Proposed, S-40, ticket #70.)* The cart, the order and the tracker:
- **The cart** is in the page only: Add puts an item in it (the same item again raises its quantity, 1 to 20), each line has its own note, and up to 20 different items go in one order. *(Proposed, #99)* The note field grows with the note and is one line of text (a line break becomes a space); beside its label it says how many of the 200 characters are used, and that the limit is reached at 200. The line shows the price the menu shows, in the restaurant's `currency_mode` (it is on the Add button, rendered with the cached page), with no total: the page takes no payment. The cart is not remembered if the page is reloaded; the name is (see Orders).
- **One order, several lines.** `POST /api/t/{qr_token}/orders` takes repeated `item`, `quantity` and `note` fields, in step (the notes may all be left out), plus `name` and `session`. All of it is one order and one transaction: if any line can't be ordered now, the whole order is refused (409, `unavailable`, with the item's id so the page takes that line out), and nothing is written. *(Proposed, #87)* The page then says which item went ("Sorry, Rice isn't available right now. It was taken out of your order."), in the sheet above its buttons, or, when nothing is left in the cart, under the header, scrolled into view wherever the guest was (that message outlives the polls, even one that finds a waiter call, and goes at the guest's next Add, their own waiter call, or the session's end); and that item's Add is disabled and reads "Sold out" on the open page, without a reload. With several sold-out lines, each refusal names one; the rest follow on the next try. Each line freezes its own price as before. The rate limit counts orders, not lines.
- **The tracker** is `GET /api/t/{qr_token}/tracker`, uncached. The token is its only input. It answers `{ session, items, waiter }`: the table's one open session (null if there is none), whether a waiter call is pending on it (*proposed*, #97: true or false, with no time and nothing about staff) and every item in it, from every phone at the table, oldest first, each with `quantity`, `name`, `note`, `customer`, `status` and `time` (the hour and minute it was ordered, on the restaurant's clock, `restaurants.timezone`). A voided item is listed as `voided`; the reason staff gave and who voided it are never sent. Nothing from a closed session or another table is in it, and it carries no ids. It is a pure read: it neither opens a session nor counts as activity, so a phone left open doesn't keep a table from idling out.
- *(Proposed, #99)* **What the tracker says.** A voided item reads "Voided", struck through, with "Ask a member of staff about this item." The green "Ordered:" confirmation comes down once the session has more voided lines of a dish it names than it had when that submission was first made (the tracker carries no ids to match by), so a void never sits under it; the list then says which. An order's lines keep the cart's order on the tracker, the kitchen and the floor: their ids are made in rising order, and every list reads them by id (orders placed before #99 keep their old order). "Pay at the table with your waiter as usual" is said once in the card, and "Your table's orders" shows only over a list. **Words** are the same on the guest page, the kitchen and the floor: Placed, Cooking, Done, Voided, except that delivered reads "Served" to a guest (S-41) and "Delivered" to staff. A quantity is always "2 × Beef stew", with the spaces.
- *(Proposed, #99)* **The table's name.** The scan (`POST /session`) answers `{ session, table }`, and the page shows `table` under the restaurant's name. The label stays off the cached page and the tracker. A label that is only a number ("7", "12b") reads "Table 7" to the guest, on the kitchen board and on the floor; any other label is shown as it is.
- **Polling.** The page asks every 5 seconds while it is showing (not while the tab is hidden, and again at once when it comes back), and right after its own order. A poll is the token's lookup, one read joining the table, its open session and the restaurant, and one indexed read of the session's items (`orders` by restaurant, session and time, then its lines). The scan on load is the only write.
- **A session that has ended.** If the tracker's session isn't the one the page joined (staff cleared the table, or it idled out, or another party has since opened one), the page says "This table's session has ended" and drops the list. The next Add or Place order joins the table's current session first and clears the name, so the next party is asked again. *(Proposed, #85)* An old cart isn't sent on that tap: if any line was added in an earlier session, the page joins, says the session has ended and to check the order and name, and sends only when the guest places it again. The same holds when an Add or a waiter call did the joining. A cart started after the end was shown goes straight in, and so does any cart if staff reopened the same session. A retry of a lost order still goes to its own session first (#84), which an ended session can only answer, never place.

## Staff: floor view
- A grid of tables showing status (free, open, flagged), time open, and item counts by status.
- A table whose customers pressed "Call a waiter" *(proposed)* is marked "Calling a waiter since HH:MM" on the grid and in its detail until staff dismiss it (one tap, either place) or the session closes. Pressing it again while one is pending changes nothing.
- Table detail: every order and item, plus mark delivered, void (with a reason), reject an order (with a reason, S-36), clear table, force-close, and reopen (within the window). *(Proposed, #76)* A free table shows its last session's close ("Closed as idle, closed at 21:40. It can be reopened until 21:55") with a Reopen button, only while that session can be reopened.
- *(Proposed, #102)* Table detail also settles the bill and says what is wrong. Each line shows its frozen price times its quantity (S-21), laid out in the restaurant's `currency_mode` like the menu (a currency that couldn't be worked out falls back to the other; a line with neither says "No price"); a voided line's price is struck through and not counted. A Total, per currency, sums the lines that aren't voided; a currency in which any counted line has no price has no total, so a sum with a hole is never shown. A flagged table (idle, with a line in play) shows the flag, as the grid does. The grid marks a free table whose last session can still be reopened ("Last session can be reopened"), found in two reads for the whole grid (`table_latest_session`, then those sessions by key), not one per table. In the pinned bar, Clear table is disabled while an item is outstanding, and a refusal from the bar shows on the page itself, after the list and the Total and scrolled into view. It is in the page's flow, so it covers nothing, can be scrolled away, and can't move the bar's buttons or swell the bar. A force-close with nothing outstanding records its reason "with the close", not "on each voided item". Every refusal of the table detail's that says the page is out of date (a changed session, items in the way of a Clear, a delivered or voided line, a reopen that can't be) carries `refresh: true`, so the page reloads with the message still up, in that same place even when the refused form has left the page, until the next action is sent. Those messages don't ask the reader to reload. Booking and walk-in refusals (spec 04) don't reload the page. No floor polling is added (#86).
- Idle sessions that are blocked by undelivered items are shown as flagged. *(Proposed, #75)* On the grid: an open session with no activity for 90 minutes (on the database's clock) and at least one line placed, cooking or done is `flagged` instead of `open`, marked "Flagged: No activity for 90 minutes, and items not delivered". It stops being flagged when staff deliver or void the lines (idle expiry then closes it on its next run), or when the customers do something that counts as activity.

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
- [ ] Force-close refuses, with the new list, if the outstanding items changed since it was shown (#95).
- [ ] Retrying an order whose response was lost places it once, and shows the original as placed; ordering the same thing again deliberately still places a second order (#84).
- [ ] A cart from an ended session is never sent into the next one, fresh or opened by another phone, until the name is entered again and the guest confirms (#85).
- [ ] Reopen works at 14 minutes and is refused at 16 minutes. It is also refused if a new party has opened the table since, even if that party's session has already closed.
- [ ] A reopened session is not closed by idle expiry on the next job run.
- [ ] Changing a menu price after an order doesn't change that order's lines.
- [ ] Idle expiry closes a fully delivered session at 90 minutes of inactivity, not 90 minutes since it opened.
- [ ] A staff reject voids every item of the order (undelivered items only, *proposed*, see S-36), recorded with the staff member and reason, and the order leaves the kitchen board (S-36). This replaces "a remote order can't reach the kitchen", which no longer fits D-01's decision: a remote order does reach it.
