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
  // Past an hour, "95 min ago" is a sum to do in the head (#101).
  const label =
    whole < 1
      ? "just now"
      : whole < 60
        ? `${whole} min ago`
        : `${Math.floor(whole / 60)} h${whole % 60 ? ` ${whole % 60} min` : ""} ago`;
  return { level, label } as const;
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
    const held = next.get(change.id);
    // A change older than what the board holds is a late answer: it must not undo a newer state (#101).
    if (held && Date.parse(change.statusChangedAt) < Date.parse(held.statusChangedAt)) continue;
    if (!held) arrived.push(change.id);
    next.set(change.id, change);
  }
  return { board: next, arrived };
}

/**
 * The items of one move's answer worth applying (#101): only ones the board still
 * holds, since a poll may have taken the item off it (delivered, voided) while
 * the answer was on its way, and an answer must not bring it back, as a new
 * arrival with a flash and a beep. Older ones are dropped by applyChanges.
 */
export const freshAnswers = (board: ReadonlyMap<string, BoardItem>, items: BoardItem[]) =>
  items.filter((item) => {
    const held = board.get(item.id);
    return held !== undefined && Date.parse(item.statusChangedAt) >= Date.parse(held.statusChangedAt);
  });

/**
 * What the board holds, changed by polls and by moves' answers, which can cross:
 * a poll read before an item was delivered or voided may be answered after, and
 * must not bring the item back (#135). One poll runs at a time, so only the one in
 * flight can be that old, and an item that left needs remembering only until the
 * next poll is shown.
 */
export function liveBoard(initial: BoardItem[]) {
  let board: ReadonlyMap<string, BoardItem> = new Map(initial.map((item) => [item.id, item]));
  const left = new Set<string>();
  const apply = (items: BoardItem[]) => {
    const next = applyChanges(board, items);
    for (const id of board.keys()) if (!next.board.has(id)) left.add(id);
    board = next.board;
    return next;
  };
  return {
    board: () => board,
    /** A move's, void's or reject's answer, applied only if it is still true of the board. */
    answered: (items: BoardItem[]) => apply(freshAnswers(board, items)),
    /** A poll's changes. */
    polled(items: BoardItem[]) {
      const next = apply(items.filter((item) => !left.has(item.id)));
      left.clear();
      return next;
    },
  };
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

/** How long a spot stays guarded after its move settles, or after a tap there is refused. */
export const SAME_SPOT_MS = 600;
/** How far from a guarded spot still counts as on it, in CSS px. */
export const SAME_SPOT_PX = 40;
/** How far past its slide ignored taps can extend a spot's guard: a triple tap is a slip, steady tapping isn't (#135). */
export const SAME_SPOT_MAX_MS = 2 * SAME_SPOT_MS;
/** The longest a move in flight holds its spot, and how long after a lost answer a poll may still show its move late. */
export const SAME_SPOT_HOLD_MS = 10_000;

/** Where and when a tap landed (`event.timeStamp`), and on which item. */
export type Tap = { itemId: string; x: number; y: number; at: number; fromPointer: boolean };

/**
 * A finger that lands twice on one spot (#100): the first tap's move takes a
 * ticket away and the next slides under the finger, so the second tap would
 * start another table's order. A ticket slides when the move is answered, or a
 * poll shows it, not when it is tapped, so a tap's spot is held while its move is
 * in flight and for SAME_SPOT_MS after, and a tap there on another item is
 * refused. A move whose answer was lost (timed out, dropped, a server error) may
 * still have worked, so its spot is held until the board shows the real state: a
 * poll asked since then, or an answer to a retap of the item (#101, #135). Other
 * spots work as ever. A click that isn't a pointer's (`detail` 0,
 * such as a keyboard's) has no position and is never refused; a touch screen
 * reader may send a pointer's click, which is guarded like a tap.
 */
export function sameSpotGuard() {
  // One per accepted tap. `until` is when it stops guarding, and `limit` is as far
  // as ignored taps can push that. An `open` spot is kept past it, because the
  // poll that shows its move still slides a ticket, so it guards again. `lostAt`
  // is when its move's answer was lost.
  type Spot = Tap & { until: number; limit?: number; open: boolean; lostAt?: number; polled?: boolean };
  let spots: Spot[] = [];
  const guard = (spot: Spot, at: number) => {
    spot.until = at + SAME_SPOT_MS;
    spot.limit = at + SAME_SPOT_MAX_MS;
  };
  return {
    /** True when the tap should act. A pointer's is recorded: call `settled` or `unanswered` when its move is over. */
    allow(tap: Tap): boolean {
      if (!tap.fromPointer) return true;
      spots = spots.filter((spot) => spot.open || tap.at < spot.until);
      const hit = spots.filter(
        (spot) =>
          spot.itemId !== tap.itemId &&
          tap.at < spot.until &&
          Math.hypot(tap.x - spot.x, tap.y - spot.y) < SAME_SPOT_PX,
      );
      if (hit.length > 0) {
        // A third tap is as stray as the second. One with no limit yet is held already.
        for (const spot of hit) {
          if (spot.limit !== undefined) spot.until = Math.min(tap.at + SAME_SPOT_MS, spot.limit);
        }
        return false;
      }
      spots.push({ ...tap, until: tap.at + SAME_SPOT_HOLD_MS, open: true });
      return true;
    },
    /** The item's move was applied or refused, `at` (`performance.now()`, the taps' clock). Leaves a lost one held. */
    settled(itemId: string, at: number) {
      for (const spot of spots) {
        if (!spot.open || spot.lostAt !== undefined || spot.itemId !== itemId) continue;
        spot.open = false;
        guard(spot, at);
      }
    },
    /** An answer showed where the item really is, so an earlier lost move of it is known too. */
    shown(itemId: string, at: number) {
      for (const spot of spots) {
        if (!spot.open || spot.lostAt === undefined || spot.itemId !== itemId) continue;
        spot.open = false;
        guard(spot, at);
      }
    },
    /** The item's move's answer was lost `at`, so whether it worked isn't known until the board shows it. */
    unanswered(itemId: string, at: number) {
      for (const spot of spots) {
        if (!spot.open || spot.lostAt !== undefined || spot.itemId !== itemId) continue;
        spot.lostAt = at;
        spot.until = Infinity;
      }
    },
    /**
     * A poll asked at `askedAt` was shown `at`, with these items changed. One asked
     * before an answer was lost may not know of that move. The first asked since ends
     * the hold, SAME_SPOT_MS later. The server may still have been applying the move,
     * so if a poll soon after has the item, its ticket slides then, and is guarded then.
     */
    polled(askedAt: number, at: number, itemIds: string[]) {
      for (const spot of spots) {
        if (!spot.open || spot.lostAt === undefined || askedAt < spot.lostAt) continue;
        const shown = itemIds.includes(spot.itemId);
        if (shown || !spot.polled) guard(spot, at);
        spot.polled = true;
        spot.open = !shown && askedAt < spot.lostAt + SAME_SPOT_HOLD_MS;
      }
    },
  };
}

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
 * How long a move, void or reject may go unanswered (#101). Past it the request
 * is cancelled, so its late answer can never be applied, the row is free again
 * and the board says so. Longer than a poll's 4 seconds, and shorter than
 * SAME_SPOT_HOLD_MS, so the spot is still held when a timeout holds it on.
 */
export const MOVE_TIMEOUT_MS = 8_000;

/** Said when a move timed out. It may still have worked: the board is refreshed to find out. */
export const MOVE_TIMEOUT_MESSAGE =
  "The server took too long to answer. Check the board, then tap again if it didn't move.";

/** Said when a move's answer was lost some other way. It may have worked too. */
export const MOVE_LOST_MESSAGE =
  "No clear answer from the server. Check the board, then tap again if nothing changed.";

/** Runs `request` with a signal that aborts after MOVE_TIMEOUT_MS; `timedOut` says that is why it failed. */
async function withTimeout<T>(
  request: (signal: AbortSignal) => Promise<T>,
): Promise<{ failed: false; value: T } | { failed: true; timedOut: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MOVE_TIMEOUT_MS);
  try {
    return { failed: false, value: await request(controller.signal) };
  } catch {
    return { failed: true, timedOut: controller.signal.aborted };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One move from the board (spec 07): posts the status the card showed and the
 * one wanted. A move that worked is applied. A refused one (409: skipped, or
 * another tablet moved it first) shows the item where it really is, says so, and
 * refreshes the board. One whose answer was lost (timed out, dropped, a server
 * error, a body that can't be read) may have worked, so it calls `lost`, then
 * refreshes: only a poll asked after that says (#135).
 */
export async function sendMove(
  item: BoardItem,
  to: ItemStatus,
  deps: {
    fetch: (url: string, init: { method: string; body: FormData; signal: AbortSignal }) => Promise<Response>;
    apply: (items: BoardItem[]) => void;
    say: (message: string | undefined) => void;
    poller: { refresh: () => void } | null;
    lost?: () => void;
  },
) {
  deps.say(undefined);
  const body = new FormData();
  body.set("from", item.status);
  body.set("to", to);
  const sent = await withTimeout(async (signal) => {
    const response = await deps.fetch(`/api/kitchen/items/${item.id}/status`, { method: "POST", body, signal });
    const answer = (await response.json().catch((error) => {
      // A body that never finishes is a timeout, not an empty answer.
      if (signal.aborted) throw error;
      return {};
    })) as { item?: BoardItem; status?: ItemStatus; error?: string };
    return { ok: response.ok, unclear: response.status >= 500 || (response.ok && !answer.item), answer };
  });
  if (sent.failed || sent.value.unclear) {
    deps.say(sent.failed && sent.timedOut ? MOVE_TIMEOUT_MESSAGE : MOVE_LOST_MESSAGE);
    deps.lost?.();
    deps.poller?.refresh();
    return;
  }
  const { ok, answer } = sent.value;
  if (ok && answer.item) {
    deps.apply([answer.item]);
  } else {
    deps.say(answer.error ?? "That didn't work. Try again.");
    if (answer.status) deps.apply([{ ...item, status: answer.status }]);
    deps.poller?.refresh();
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
    init: { method: string; body: FormData; headers?: Record<string, string>; signal: AbortSignal },
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
  const body = new FormData();
  body.set("reason", reason);
  const sent = await withTimeout(async (signal) => {
    const response = await deps.fetch(url, {
      method: "POST",
      body,
      headers: { [FORM_FETCH_HEADER]: "1" },
      signal,
    });
    if (response.ok) return { ok: true as const };
    const answer = (await response.json().catch((error) => {
      if (signal.aborted) throw error;
      return {};
    })) as { error?: string };
    return { ok: false as const, error: answer.error };
  });
  if (sent.failed) {
    deps.say(sent.timedOut ? MOVE_TIMEOUT_MESSAGE : MOVE_LOST_MESSAGE);
    deps.poller?.refresh();
    return false;
  }
  if (sent.value.ok) {
    deps.apply(gone.map((item) => ({ ...item, status: "voided" as const })));
    return true;
  }
  deps.say(sent.value.error ?? "That didn't work. Try again.");
  deps.poller?.refresh();
  return false;
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
