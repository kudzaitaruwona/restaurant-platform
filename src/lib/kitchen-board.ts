/**
 * The kitchen board's rules (spec 07), shared by the server, which enforces the
 * moves, and the board in the browser, which offers them. No server-only
 * imports: the board's client bundle loads this.
 */

export type ItemStatus = "placed" | "cooking" | "done" | "delivered" | "voided";

/** One card: one line of an order, as the board needs it. Times are ISO strings. */
export type BoardItem = {
  id: string;
  orderId: string;
  table: string;
  quantity: number;
  name: string;
  note: string | null;
  customerName: string;
  placedAt: string;
  status: ItemStatus;
  statusChangedAt: string;
};

/** The board's columns, left to right. Delivered and voided items leave it. */
export const BOARD_STATUSES = ["placed", "cooking", "done"] as const;
export type BoardStatus = (typeof BOARD_STATUSES)[number];

const FORWARD = ["placed", "cooking", "done", "delivered"] as const;

/** One tap: the next status, or none past delivered. */
export function nextStatus(status: ItemStatus): ItemStatus | undefined {
  const at = FORWARD.indexOf(status as (typeof FORWARD)[number]);
  return at >= 0 ? FORWARD[at + 1] : undefined;
}

/**
 * Back one status, for a mis-tap: cooking → placed and done → cooking. Not back
 * from delivered, which has left the board.
 */
export function previousStatus(status: ItemStatus): ItemStatus | undefined {
  if (status === "cooking") return "placed";
  if (status === "done") return "cooking";
  return undefined;
}

/** Whether `from → to` is one step forward or one step back. Anything else skips. */
export const isMove = (from: ItemStatus, to: ItemStatus) =>
  nextStatus(from) === to || previousStatus(from) === to;

export const onBoard = (status: ItemStatus): status is BoardStatus =>
  (BOARD_STATUSES as readonly string[]).includes(status);

const MINUTE = 60_000;
/** Proposed thresholds (spec 07), configurable later. */
export const AMBER_AFTER_MINUTES = 15;
export const RED_AFTER_MINUTES = 25;

/**
 * How late an item is (proposed, #71): the clock runs from ordering, in Placed
 * and in Cooking alike, because that is how long the table has waited. Moving an
 * item back and forth doesn't restart it. A done item is cooked, so it doesn't
 * age. `now` is the server's clock, as the board estimates it.
 */
export function ageOf(item: BoardItem, now: Date) {
  const minutes = Math.max(0, (now.getTime() - Date.parse(item.placedAt)) / MINUTE);
  const level =
    item.status === "done"
      ? "fresh"
      : minutes >= RED_AFTER_MINUTES
        ? "red"
        : minutes >= AMBER_AFTER_MINUTES
          ? "amber"
          : "fresh";
  const whole = Math.floor(minutes);
  return { level, label: whole < 1 ? "just now" : `${whole} min ago` } as const;
}

/**
 * A poll's changed items applied to the board, without changing the one given.
 * `arrived` is the items the board hadn't seen, still on it: what flashes and
 * plays the sound.
 */
export function applyChanges(board: ReadonlyMap<string, BoardItem>, changes: BoardItem[]) {
  const next = new Map(board);
  const arrived: string[] = [];
  for (const change of changes) {
    if (!onBoard(change.status)) {
      next.delete(change.id);
      continue;
    }
    if (!next.has(change.id)) arrived.push(change.id);
    next.set(change.id, change);
  }
  return { board: next, arrived };
}

/** An order's items in one column, so the kitchen can plate a table together. */
export type BoardGroup = { orderId: string; table: string; customerName: string; items: BoardItem[] };

/** The three columns, each with its items grouped by order, oldest order first. */
export function boardColumns(board: ReadonlyMap<string, BoardItem>) {
  const sorted = [...board.values()].sort(
    (a, b) =>
      a.placedAt.localeCompare(b.placedAt) ||
      a.orderId.localeCompare(b.orderId) ||
      a.id.localeCompare(b.id),
  );
  return BOARD_STATUSES.map((status) => {
    const groups: BoardGroup[] = [];
    for (const item of sorted.filter((it) => it.status === status)) {
      const last = groups.at(-1);
      if (last?.orderId === item.orderId) last.items.push(item);
      else
        groups.push({
          orderId: item.orderId,
          table: item.table,
          customerName: item.customerName,
          items: [item],
        });
    }
    return { status, groups };
  });
}
