# 07 · Kitchen View

**Phase 6.** It ships with QR ordering (spec 06) and is useless without it. Items marked *proposed* are built as written and stay marked proposed (S-36 in `docs/decisions.md`).

## Goal
The kitchen sees every incoming item with its table and notes, and moves items through cooking, done and delivered without paper tickets.

## Decided
- Shows the order, its table, and **per-item notes**.
- Orders arrive with no staff approval (D-01, settled as S-36), so the board is where staff first see a suspicious order, and can reject it from here.
- Status is tracked per item: placed → cooking → done → delivered.

## Layout `/dashboard/kitchen`
Staff pages live under `/dashboard/*` (D-10). Ticket #69 built this path as a plain list of placed items (table label, quantity × item name, note, customer name), for owner and staff, linked from the dashboard, and ticket #71 grew it into the board below.

- Designed for a tablet in landscape, which staff leave logged in.
- **Three columns:** Placed · Cooking · Done. Delivered items disappear from the board.
- Each card is one item: table label (large), quantity × item name, the note **highlighted**, customer name, and how long ago it was ordered.
- Items from the same order and table are grouped visually, so the kitchen can plate a table together.
- **One tap** moves an item forward. A long press or a menu moves it back (for mis-taps), voids it (with a reason), or rejects its whole order (with a reason, S-36).
  - *(Proposed, #71)* A tap on a Done card marks it delivered, which takes it off the board. A move sends the status the board showed and the one wanted; a move that skips a status, or from a status the item has already left (another tablet moved it first), is refused (409) and the board refreshes. Every move is audited (`order_item.status`, with from and to) and bumps the session's `last_activity_at` in the same transaction, if the session is open.
- **Ageing:** a card turns amber after 15 minutes in Placed or Cooking and the strongest amber after 25 (a solid amber age and border, not red: red means destructive, S-41) *(proposed thresholds, configurable later)*. *(Proposed, #71)* The clock runs from ordering (`orders.placed_at`), in both columns, not from entering the column: it measures how long the table has waited, and moving an item back and forth doesn't restart it. Done cards don't age. "How long ago it was ordered" and the ageing use the server's clock, which each poll sends.
- A sound and visual flash when new items arrive. Browsers need one tap to unlock audio, so show a "Tap to enable sound" banner on load.

## Live updates (proposed)
- Poll every 5 seconds with a lightweight endpoint that returns only changes since the last timestamp.
  - *(Proposed, #71)* `GET /api/kitchen/changes?since={cursor}`. The cursor is not a timestamp: a timestamp is when the writing transaction started, so a change committed after a poll but stamped before it would be skipped. It is the oldest transaction id still running when the poll read (the snapshot's xmin), and each line carries the id of the transaction that last wrote it (`change_xid`, spec 00). Asking for `>=` can return a line twice, never miss one. Without `since` it returns the whole board.
  - *(Proposed, #71)* A poll that fails, or takes over 4 seconds, shows the offline bar at once, so it is up within 9 seconds of the network going; the next poll that answers takes it down. A signed-out session shows "Signed out" instead.
- Polling is chosen over WebSockets because it is simpler on Vercel's serverless runtime, handles flaky restaurant Wi-Fi gracefully, and 5 seconds is fast enough for a kitchen.
- Show a visible "Offline — reconnecting" bar if polls fail. A silently stale kitchen screen is the worst failure mode.

## Who can do what
- Any logged-in staff member can move items through cooking and done.
- **Delivered** is set by front-of-house in the floor view (spec 06), or from the kitchen view if the restaurant uses it that way.
- Void and reject require a reason and are audited.

## Out of scope (v1)
- Kitchen printers and tickets
- Per-station routing (grill, bar)
- Prep-time estimates shown to customers

## Acceptance
- [ ] A new order appears on the kitchen board within 5 seconds.
- [ ] Notes are visually distinct and never truncated.
- [ ] Losing network shows the offline bar within 15 seconds and recovers automatically.
- [ ] A mis-tapped item can be moved back one status.
