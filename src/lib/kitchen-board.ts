/**
 * The kitchen board's rules (spec 07), shared by the server, which enforces the
 * moves, and the board in the browser, which offers them. No server-only
 * imports: the board's client bundle loads this.
 */

import { FORM_FETCH_HEADER } from "@/lib/form-response";

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

/** What a card's menu offers for an item in `status` (#73, spec 07), in order. */
export function cardMenuActions(status: ItemStatus): ("back" | "void" | "reject")[] {
  return previousStatus(status) ? ["back", "void", "reject"] : ["void", "reject"];
}

/** Every item of an order that the board holds: what a reject takes off it. */
export const itemsOfOrder = (board: ReadonlyMap<string, BoardItem>, orderId: string) =>
  [...board.values()].filter((it) => it.orderId === orderId);

/** How long a new card flashes. */
export const FLASH_MS = 4_000;

/** Two short beeps, made on the spot: no sound file to fetch. */
function beep(audio: AudioContext) {
  for (const start of [0, 0.25]) {
    const tone = audio.createOscillator();
    const gain = audio.createGain();
    tone.frequency.value = 880;
    gain.gain.value = 0.2;
    tone.connect(gain).connect(audio.destination);
    tone.start(audio.currentTime + start);
    tone.stop(audio.currentTime + start + 0.15);
  }
}

/**
 * What the board does when new items arrive (spec 07): they flash for 4
 * seconds, and two beeps play once a tap has enabled sound (browsers won't play
 * audio before one). `onFlash` gets the ids flashing now.
 */
export function arrivals(options: {
  makeAudio: () => AudioContext;
  onFlash: (ids: ReadonlySet<string>) => void;
}) {
  let audio: AudioContext | undefined;
  let flashing: ReadonlySet<string> = new Set();
  const show = (next: ReadonlySet<string>) => {
    flashing = next;
    options.onFlash(next);
  };
  return {
    /** The tap on "Tap to enable sound". */
    enableSound() {
      audio ??= options.makeAudio();
      void audio.resume();
    },
    arrive(ids: string[]) {
      if (ids.length === 0) return;
      show(new Set([...flashing, ...ids]));
      setTimeout(() => show(new Set([...flashing].filter((id) => !ids.includes(id)))), FLASH_MS);
      if (audio) beep(audio);
    },
  };
}

/**
 * One move from the board (spec 07): posts the status the card showed and the
 * one wanted. A move that worked is applied. A refused one (409: skipped, or
 * another tablet moved it first) shows the item where it really is, says so, and
 * refreshes the board.
 */
export async function sendMove(
  item: BoardItem,
  to: ItemStatus,
  deps: {
    fetch: (url: string, init: { method: string; body: FormData }) => Promise<Response>;
    apply: (items: BoardItem[]) => void;
    say: (message: string | undefined) => void;
    poller: { refresh: () => void } | null;
  },
) {
  deps.say(undefined);
  try {
    const body = new FormData();
    body.set("from", item.status);
    body.set("to", to);
    const response = await deps.fetch(`/api/kitchen/items/${item.id}/status`, { method: "POST", body });
    const answer = (await response.json().catch(() => ({}))) as {
      item?: BoardItem;
      status?: ItemStatus;
      error?: string;
    };
    if (response.ok && answer.item) {
      deps.apply([answer.item]);
    } else {
      deps.say(answer.error ?? "That didn't work. Try again.");
      if (answer.status) deps.apply([{ ...item, status: answer.status }]);
      deps.poller?.refresh();
    }
  } catch {
    deps.say("That didn't reach the server. Try again.");
  }
}

/** A void's or reject's reason (#73, proposed): up to 200 characters, like a note. */
export const VOID_REASON_MAX = 200;

/**
 * The reason a void or reject form sent, trimmed, or null when it is missing,
 * blank or too long. Postgres's order_items_void_recorded holds the same rule.
 */
export function voidReasonFrom(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const reason = value.trim();
  return reason !== "" && reason.length <= VOID_REASON_MAX ? reason : null;
}

type OverrideDeps = {
  fetch: (
    url: string,
    init: { method: string; body: FormData; headers?: Record<string, string> },
  ) => Promise<Response>;
  apply: (items: BoardItem[]) => void;
  say: (message: string | undefined) => void;
  poller: { refresh: () => void } | null;
};

/**
 * Posts a void or reject as a form, as ActionForm does (FORM_FETCH_HEADER
 * asks for a 204, not a redirect). On success the given items leave the board at
 * once, as voided; a refusal says why and refreshes the board. Whether it worked.
 */
async function sendOverride(url: string, reason: string, gone: BoardItem[], deps: OverrideDeps) {
  deps.say(undefined);
  try {
    const body = new FormData();
    body.set("reason", reason);
    const response = await deps.fetch(url, {
      method: "POST",
      body,
      headers: { [FORM_FETCH_HEADER]: "1" },
    });
    if (response.ok) {
      deps.apply(gone.map((item) => ({ ...item, status: "voided" as const })));
      return true;
    }
    const answer = (await response.json().catch(() => ({}))) as { error?: string };
    deps.say(answer.error ?? "That didn't work. Try again.");
    deps.poller?.refresh();
    return false;
  } catch {
    deps.say("That didn't reach the server. Try again.");
    return false;
  }
}

/** Void one item from its card's menu (#73), with a reason. */
export const sendVoid = (item: BoardItem, reason: string, deps: OverrideDeps) =>
  sendOverride(`/api/order-items/${item.id}/void`, reason, [item], deps);

/**
 * Reject the card's whole order (#73, S-36), with a reason. `onBoard` is the
 * order's items the board shows, which all leave it.
 */
export const sendReject = (item: BoardItem, onBoard: BoardItem[], reason: string, deps: OverrideDeps) =>
  sendOverride(`/api/orders/${item.orderId}/reject`, reason, onBoard, deps);
