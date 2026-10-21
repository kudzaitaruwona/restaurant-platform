# 06 · QR Table Ordering and Sessions

**Phase 6. Blocked on [D-01](../decisions.md#d-01-fake-remote-qr-orders), the fake remote orders problem.** Everything else in this spec is decided, except items marked *proposed*. Don't start building until D-01 is resolved.

## Goal
Customers at a table scan, order, and track their food without waiting to flag a waiter. This runs alongside waiters, not instead of them. The restaurant keeps taking payment on its own swipe machine.

## Validation note
Unlike bookings, **QR ordering has no demand evidence yet.** Test it in person with owners this summer before investing past this spec.

## Decided

### Sessions
- A session belongs to a table. **Only one session can be open per table**, and the table is locked to it.
- The first scan of a table with no open session opens one (subject to D-01). Later scans **join** the open session, which covers latecomers.
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
- Customers enter **only a name** ("Name for the waiter"). It must not be empty, and anything else is accepted. The name is remembered on that phone for the session.
- Each order line **freezes its prices** (USD, ZiG, and whether the ZiG price was fixed or calculated), plus the exchange rate used.
- Status is tracked **per item**: placed → cooking → done → delivered, with `voided` for cancellations.
- Each item can have a note ("no onions").
- If an item has an active special, the line records `special_id`.

### Access
- Customers stay anonymous, and orders attach to the session.
- Staff login is required for: clear table, force-close, void, reopen, and every kitchen status change.

## D-01 options (decide before building)
| Option | Customer friction | Staff cost | Stops photo-of-QR fraud |
|--------|-------------------|------------|-------------------------|
| **Staff approve new sessions** (recommended) | None; the first order shows "Waiting for staff to confirm your table" | One tap per new table | Yes |
| Per-table code | Type a short code every visit | None | Yes, if the code rotates per session |
| Both, chosen per restaurant | Varies | Varies | Yes; the most to build |

`table_sessions.approved_at` already exists in the data model, so the recommended option needs no schema change.

## Customer flow `/t/{qr_token}`
1. Menu (the same page as spec 02) with "Add" buttons and a cart
2. Cart → name → **Place order**
3. **Order tracker**, a live view of every item in the session with its status. This is shared, so everyone at the table sees everything.
4. "Call a waiter" link *(proposed)*: sends a flag to the staff view, with no chat
5. No payment step. "Pay at the table with your waiter as usual."

The page must keep the spec 02 performance budget. The cart and tracker are the only client-side JavaScript.

## Staff: floor view
- A grid of tables showing status (free, open, flagged), time open, and item counts by status.
- Table detail: every order and item, plus mark delivered, void (with a reason), clear table, force-close, and reopen (within the window).
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
- [ ] Whatever D-01 decides has an automated test showing a remote order can't reach the kitchen.
