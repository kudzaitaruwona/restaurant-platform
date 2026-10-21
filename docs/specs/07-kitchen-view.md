# 07 · Kitchen View

**Phase 6.** It ships with QR ordering (spec 06) and is useless without it.

## Goal
The kitchen sees every incoming item with its table and notes, and moves items through cooking, done and delivered without paper tickets.

## Decided
- Shows the order, its table, and **per-item notes**.
- Status is tracked per item: placed → cooking → done → delivered.

## Layout `/admin/kitchen`
- Designed for a tablet in landscape, which staff leave logged in.
- **Three columns:** Placed · Cooking · Done. Delivered items disappear from the board.
- Each card is one item: table label (large), quantity × item name, the note **highlighted**, customer name, and how long ago it was ordered.
- Items from the same order and table are grouped visually, so the kitchen can plate a table together.
- **One tap** moves an item forward. A long press or a menu moves it back (for mis-taps) or voids it (with a reason).
- **Ageing:** a card turns amber after 15 minutes in Placed or Cooking and red after 25 *(proposed thresholds, configurable later)*.
- A sound and visual flash when new items arrive. Browsers need one tap to unlock audio, so show a "Tap to enable sound" banner on load.

## Live updates (proposed)
- Poll every 5 seconds with a lightweight endpoint that returns only changes since the last timestamp.
- Polling is chosen over WebSockets because it is simpler on Vercel's serverless runtime, handles flaky restaurant Wi-Fi gracefully, and 5 seconds is fast enough for a kitchen.
- Show a visible "Offline — reconnecting" bar if polls fail. A silently stale kitchen screen is the worst failure mode.

## Who can do what
- Any logged-in staff member can move items through cooking and done.
- **Delivered** is set by front-of-house in the floor view (spec 06), or from the kitchen view if the restaurant uses it that way.
- Void requires a reason and is audited.

## Out of scope (v1)
- Kitchen printers and tickets
- Per-station routing (grill, bar)
- Prep-time estimates shown to customers

## Acceptance
- [ ] A new order appears on the kitchen board within 5 seconds.
- [ ] Notes are visually distinct and never truncated.
- [ ] Losing network shows the offline bar within 15 seconds and recovers automatically.
- [ ] A mis-tapped item can be moved back one status.
