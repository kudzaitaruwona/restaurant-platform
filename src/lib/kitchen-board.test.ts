import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ageOf,
  type BoardItem,
  applyChanges,
  arrivals,
  boardColumns,
  FLASH_MS,
  cardMenuActions,
  freshAnswers,
  isMove,
  sameSpotGuard,
  SAME_SPOT_HOLD_MS,
  SAME_SPOT_MS,
  itemsOfOrder,
  liveBoard,
  MOVE_TIMEOUT_MS,
  nextStatus,
  previousStatus,
  sendMove,
  sendReject,
  sendVoid,
  VOID_REASON_MAX,
  voidReasonFrom,
} from "./kitchen-board";
import { startPolling } from "./kitchen-poll";

const MINUTE = 60_000;
const placedAt = "2026-11-11T10:00:00.000Z";
const at = (minutes: number) => new Date(Date.parse(placedAt) + minutes * MINUTE);

const item = (fields: Partial<BoardItem> = {}): BoardItem => ({
  id: crypto.randomUUID(),
  orderId: "order-1",
  table: "Table 7",
  quantity: 2,
  name: "Beef stew",
  note: null,
  customerName: "Tariro",
  placedAt,
  status: "placed",
  statusChangedAt: placedAt,
  ...fields,
});

describe("the steps an item takes", () => {
  it("goes forward one status at a time, ending at delivered", () => {
    expect(nextStatus("placed")).toBe("cooking");
    expect(nextStatus("cooking")).toBe("done");
    expect(nextStatus("done")).toBe("delivered");
    expect(nextStatus("delivered")).toBeUndefined();
  });

  it("goes back one status from cooking or done only", () => {
    expect(previousStatus("cooking")).toBe("placed");
    expect(previousStatus("done")).toBe("cooking");
    expect(previousStatus("placed")).toBeUndefined();
    expect(previousStatus("delivered")).toBeUndefined();
  });

  it.each([
    ["placed", "cooking", true],
    ["cooking", "done", true],
    ["done", "delivered", true],
    ["cooking", "placed", true],
    ["done", "cooking", true],
    ["placed", "done", false],
    ["placed", "delivered", false],
    ["delivered", "done", false],
    ["placed", "placed", false],
    ["done", "placed", false],
    ["placed", "voided", false],
  ] as const)("%s → %s is a move: %s", (from, to, allowed) => {
    expect(isMove(from, to)).toBe(allowed);
  });
});

describe("ageing (proposed: amber at 15 minutes, red at 25, from ordering)", () => {
  it.each([
    [0, "fresh"],
    [14.9, "fresh"],
    [15, "amber"],
    [24.9, "amber"],
    [25, "red"],
  ] as const)("a placed item %s minutes after ordering is %s", (minutes, level) => {
    expect(ageOf(item(), at(minutes)).level).toBe(level);
  });

  it("reads ninety-five minutes as hours and minutes, not \"95 min ago\" (#101)", () => {
    expect(ageOf(item(), at(59.9)).label).toBe("59 min ago");
    expect(ageOf(item(), at(60)).label).toBe("1 h ago");
    expect(ageOf(item(), at(95)).label).toBe("1 h 35 min ago");
    expect(ageOf(item(), at(180)).label).toBe("3 h ago");
  });

  it("runs from ordering for a cooking item, however recently it started cooking", () => {
    const cooking = item({ status: "cooking", statusChangedAt: at(20).toISOString() });
    expect(ageOf(cooking, at(26)).level).toBe("red");
  });

  it("doesn't age a done item: it is waiting to be carried, not cooked", () => {
    expect(ageOf(item({ status: "done" }), at(60)).level).toBe("fresh");
  });

  it("says how long ago it was ordered, in whole minutes", () => {
    expect(ageOf(item(), at(0.5)).label).toBe("just now");
    expect(ageOf(item(), at(7.9)).label).toBe("7 min ago");
    // A clock a little behind the server's never shows a negative age.
    expect(ageOf(item(), at(-1)).label).toBe("just now");
  });
});

describe("applying a poll's changes", () => {
  it("adds new items, updates moved ones, drops delivered and voided ones, and says which arrived", () => {
    const moved = item({ id: "moved" });
    const leaving = item({ id: "leaving", status: "done" });
    const board = new Map([moved, leaving].map((it) => [it.id, it]));

    const result = applyChanges(board, [
      { ...moved, status: "cooking" },
      { ...leaving, status: "delivered" },
      item({ id: "new" }),
      item({ id: "voided-unseen", status: "voided" }),
    ]);

    expect([...result.board.keys()].sort()).toEqual(["moved", "new"]);
    expect(result.board.get("moved")?.status).toBe("cooking");
    expect(result.arrived).toEqual(["new"]);
    expect(board.get("moved")?.status).toBe("placed");
  });

  it("ignores a change older than what the board holds, so a late answer can't undo a newer state (#101)", () => {
    const newer = item({ id: "a", status: "done", statusChangedAt: "2026-11-11T10:05:00.000Z" });
    const older = { ...newer, status: "cooking" as const, statusChangedAt: "2026-11-11T10:02:00.000Z" };
    const { board } = applyChanges(new Map([[newer.id, newer]]), [older]);
    expect(board.get("a")?.status).toBe("done");
    // The same moment is as new as the board: a refused move shows where the item is.
    expect(applyChanges(board, [{ ...newer, status: "cooking" }]).board.get("a")?.status).toBe("cooking");
  });

  it("takes an answer only for an item the board still holds and hasn't moved past (#101)", () => {
    const held = item({ id: "a", status: "cooking", statusChangedAt: "2026-11-11T10:05:00.000Z" });
    const board = new Map([[held.id, held]]);
    const gone = item({ id: "gone", status: "done" });
    const stale = { ...held, status: "placed" as const, statusChangedAt: "2026-11-11T10:01:00.000Z" };
    const fresh = { ...held, status: "done" as const, statusChangedAt: "2026-11-11T10:06:00.000Z" };
    expect(freshAnswers(board, [gone, stale])).toEqual([]);
    expect(freshAnswers(board, [fresh])).toEqual([fresh]);
  });

  it("doesn't count an item seen before as arriving again", () => {
    const seen = item({ id: "seen" });
    const result = applyChanges(new Map([[seen.id, seen]]), [seen]);
    expect(result.arrived).toEqual([]);
  });
});

describe("what the board holds (#135)", () => {
  const moved = (from: BoardItem, status: BoardItem["status"], minute: number): BoardItem => ({
    ...from,
    status,
    statusChangedAt: at(minute).toISOString(),
  });

  it("doesn't bring back a delivered item for a poll read before it was delivered", () => {
    const done = item({ id: "a", status: "done", statusChangedAt: at(5).toISOString() });
    const board = liveBoard([done]);
    expect(board.answered([moved(done, "delivered", 6)]).board.size).toBe(0);
    // In flight since before the tap, and only answered now.
    const late = board.polled([done, item({ id: "new" })]);
    expect([...late.board.keys()]).toEqual(["new"]);
    expect(late.arrived).toEqual(["new"]); // no flash and beep for the delivered one
  });

  it("doesn't bring back a voided item another tablet moved just before", () => {
    const placed = item({ id: "a" });
    const board = liveBoard([placed]);
    // A void's answer has no time of its own, so the late poll's item looks newer.
    board.answered([{ ...placed, status: "voided" }]);
    expect(board.polled([moved(placed, "cooking", 5)]).board.size).toBe(0);
  });

  it("takes every poll asked after that as it is", () => {
    const done = item({ id: "a", status: "done" });
    const board = liveBoard([done]);
    board.answered([moved(done, "delivered", 6)]);
    board.polled([done]);
    expect([...board.polled([moved(done, "done", 7)]).board.keys()]).toEqual(["a"]);
  });

  it("drops an answer for an item a poll has taken off, and applies one it still holds", () => {
    const first = item({ id: "a" });
    const second = item({ id: "b" });
    const board = liveBoard([first, second]);
    board.polled([moved(first, "delivered", 6)]);
    const next = board.answered([moved(first, "cooking", 5), moved(second, "cooking", 5)]);
    expect([...next.board.values()].map((it) => [it.id, it.status])).toEqual([["b", "cooking"]]);
  });
});

describe("the columns", () => {
  it("puts each item in its status's column, grouped by order, oldest order first", () => {
    const later = "2026-11-11T10:05:00.000Z";
    const items = [
      item({ id: "b1", orderId: "B", table: "Patio 2", placedAt: later }),
      item({ id: "a1", orderId: "A" }),
      item({ id: "a2", orderId: "A" }),
      item({ id: "a3", orderId: "A", status: "cooking" }),
      item({ id: "c1", orderId: "C", status: "done" }),
    ];

    const columns = boardColumns(new Map(items.map((it) => [it.id, it])));

    expect(columns.map((column) => column.status)).toEqual(["placed", "cooking", "done"]);
    expect(columns[0].groups.map((group) => group.items.map((it) => it.id))).toEqual([
      ["a1", "a2"],
      ["b1"],
    ]);
    expect(columns[0].groups[1].table).toBe("Patio 2");
    expect(columns[1].groups.map((group) => group.items.map((it) => it.id))).toEqual([["a3"]]);
    expect(columns[2].groups.map((group) => group.items.map((it) => it.id))).toEqual([["c1"]]);
  });
});

/** Just enough of the Web Audio API to count the beeps a board makes. */
class FakeAudio {
  currentTime = 0;
  destination = {};
  resumed = 0;
  tones: number[] = [];
  resume() {
    this.resumed += 1;
    return Promise.resolve();
  }
  createGain() {
    const gain = { gain: { value: 0 }, connect: (next: unknown) => next };
    return gain;
  }
  createOscillator() {
    const tones = this.tones;
    return {
      frequency: { value: 0 },
      connect: (next: unknown) => next,
      start: (when: number) => tones.push(when),
      stop: () => {},
    };
  }
}

describe("new items arriving", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const board = () => {
    const audio = new FakeAudio();
    let flashing: ReadonlySet<string> = new Set();
    const alert = arrivals({
      makeAudio: () => audio as unknown as AudioContext,
      onFlash: (ids) => (flashing = ids),
    });
    return { audio, alert, flashing: () => flashing };
  };

  it("flash for 4 seconds, with no sound before a tap has allowed one", () => {
    const { audio, alert, flashing } = board();

    alert.arrive(["a", "b"]);

    expect([...flashing()].sort()).toEqual(["a", "b"]);
    expect(audio.tones).toEqual([]);
    vi.advanceTimersByTime(FLASH_MS - 1);
    expect(flashing().size).toBe(2);
    vi.advanceTimersByTime(1);
    expect(flashing().size).toBe(0);
  });

  it("play a sound and flash after one tap enables sound", () => {
    const { audio, alert, flashing } = board();

    alert.enableSound();
    expect(audio.resumed).toBe(1);
    alert.arrive(["c"]);

    expect(audio.tones.length).toBeGreaterThan(0);
    expect([...flashing()]).toEqual(["c"]);
  });

  it("do nothing when nothing is new", () => {
    const { audio, alert, flashing } = board();
    alert.enableSound();

    alert.arrive([]);

    expect(audio.tones).toEqual([]);
    expect(flashing().size).toBe(0);
  });

  it("stop flashing one batch without cutting short a later one", () => {
    const { alert, flashing } = board();

    alert.arrive(["a"]);
    vi.advanceTimersByTime(2_000);
    alert.arrive(["b"]);
    vi.advanceTimersByTime(2_000);

    expect([...flashing()]).toEqual(["b"]);
  });
});

describe("sending a move", () => {
  const reply = (status: number, body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));

  const moving = (respond: () => Promise<Response>) => {
    const applied: BoardItem[][] = [];
    const said: (string | undefined)[] = [];
    const requests: { url: string; body: FormData }[] = [];
    const poller = { refreshes: 0, refresh() { this.refreshes += 1; } };
    const deps = {
      fetch: (url: string, init: { method: string; body: FormData }) => {
        requests.push({ url, body: init.body });
        return respond();
      },
      apply: (items: BoardItem[]) => void applied.push(items),
      say: (message: string | undefined) => void said.push(message),
      poller,
    };
    return { deps, applied, said, requests, poller };
  };

  it("posts the status the board showed and the one wanted, and applies the moved item", async () => {
    const card = item({ id: "item-1" });
    const moved = { ...card, status: "cooking" as const };
    const { deps, applied, requests, poller } = moving(() => reply(200, { item: moved }));

    await sendMove(card, "cooking", deps);

    expect(requests[0].url).toBe("/api/kitchen/items/item-1/status");
    expect(requests[0].body.get("from")).toBe("placed");
    expect(requests[0].body.get("to")).toBe("cooking");
    expect(applied).toEqual([[moved]]);
    expect(poller.refreshes).toBe(0);
  });

  it("on a 409, shows the item where it really is, says so, and refreshes the board", async () => {
    const card = item({ id: "item-1" });
    const { deps, applied, said, poller } = moving(() =>
      reply(409, { error: "That item had already moved.", status: "done" }),
    );

    await sendMove(card, "cooking", deps);

    expect(applied).toEqual([[{ ...card, status: "done" }]]);
    expect(said.at(-1)).toBe("That item had already moved.");
    expect(poller.refreshes).toBe(1);
  });

  it.each([
    ["the connection drops", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["a gateway gives up on the server", () => Promise.resolve(new Response("Bad gateway", { status: 502 }))],
    ["the body is cut short", () => Promise.resolve(new Response('{"item":{"id"', { status: 200 }))],
  ])("treats a move as maybe applied when %s: marks it lost, then refreshes to find out (#135)", async (_why, respond) => {
    const { deps, applied, said, poller } = moving(respond);
    const order: string[] = [];
    deps.poller = { ...poller, refresh: () => void order.push("poll") };

    await sendMove(item(), "cooking", { ...deps, lost: () => void order.push("lost") });

    expect(applied).toEqual([]);
    expect(said.at(-1)).toMatch(/no clear answer/i);
    expect(said.at(-1)).toMatch(/check the board/i);
    expect(order).toEqual(["lost", "poll"]);
  });

  it.each([400, 401, 404, 409])("takes a %i as an answer: the move wasn't applied, so nothing is lost", async (status) => {
    const { deps, poller } = moving(() => Promise.resolve(new Response("{}", { status })));
    const lost = vi.fn();

    await sendMove(item(), "cooking", { ...deps, lost });

    expect(lost).not.toHaveBeenCalled();
    expect(poller.refreshes).toBe(1);
  });
});

describe("a void's reason", () => {
  it("is the reason trimmed, up to 200 characters", () => {
    expect(voidReasonFrom("  Nobody at the table ")).toBe("Nobody at the table");
    expect(voidReasonFrom("x".repeat(VOID_REASON_MAX))).toHaveLength(200);
  });

  it.each([null, "", "   ", "x".repeat(201)])("refuses %j", (value) => {
    expect(voidReasonFrom(value)).toBeNull();
  });

  it("refuses a file", () => {
    expect(voidReasonFrom(new File(["x"], "x.txt"))).toBeNull();
  });
});

describe("a move that hangs (#101)", () => {
  afterEach(() => vi.useRealTimers());

  /** A fetch that never answers, until `answer` is called; it honours its signal as fetch does. */
  const hung = () => {
    let answer: (response: Response) => void = () => {};
    const signals: AbortSignal[] = [];
    const fetch = (_url: string, init: { signal?: AbortSignal }) =>
      new Promise<Response>((resolve, reject) => {
        answer = resolve;
        if (init.signal) {
          signals.push(init.signal);
          init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }
      });
    return { fetch, answer: (r: Response) => answer(r), signals };
  };
  const deps = (fetch: ReturnType<typeof hung>["fetch"]) => {
    const applied: BoardItem[][] = [];
    const said: (string | undefined)[] = [];
    const poller = { refreshes: 0, refresh() { this.refreshes += 1; } };
    return {
      deps: {
        fetch,
        apply: (items: BoardItem[]) => void applied.push(items),
        say: (m: string | undefined) => void said.push(m),
        poller,
      },
      applied,
      said,
      poller,
    };
  };

  it("gives up before the same-spot hold lapses, so the row is back before the guard's cap", () => {
    expect(MOVE_TIMEOUT_MS).toBeGreaterThan(4_000); // a poll's own limit
    expect(MOVE_TIMEOUT_MS).toBeLessThan(SAME_SPOT_HOLD_MS);
  });

  it("times out, says so, applies nothing and refreshes the board to find where the item really is", async () => {
    vi.useFakeTimers();
    const server = hung();
    const { deps: d, applied, said, poller } = deps(server.fetch);
    const done = sendMove(item(), "cooking", d);
    await vi.advanceTimersByTimeAsync(MOVE_TIMEOUT_MS - 1);
    expect(said.at(-1)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(server.signals[0].aborted).toBe(true);
    expect(said.at(-1)).toMatch(/too long/);
    expect(said.at(-1)).toMatch(/check the board/i);
    expect(applied).toEqual([]);
    expect(poller.refreshes).toBe(1);
  });

  it("drops a late answer: nothing is applied after the timeout", async () => {
    vi.useFakeTimers();
    const server = hung();
    const { deps: d, applied } = deps(server.fetch);
    const card = item({ id: "item-1" });
    const done = sendMove(card, "cooking", d);
    await vi.advanceTimersByTimeAsync(MOVE_TIMEOUT_MS);
    await done;
    server.answer(new Response(JSON.stringify({ item: { ...card, status: "cooking" } }), { status: 200 }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(applied).toEqual([]);
  });

  it("times out an answer whose body never finishes, too", async () => {
    vi.useFakeTimers();
    const stuck = (_url: string, init: { signal?: AbortSignal }) =>
      Promise.resolve({
        ok: true,
        json: () =>
          new Promise((_resolve, reject) =>
            init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
          ),
      } as unknown as Response);
    const { deps: d, said } = deps(stuck);
    const done = sendMove(item(), "cooking", d);
    await vi.advanceTimersByTimeAsync(MOVE_TIMEOUT_MS);
    await done;
    expect(said.at(-1)).toMatch(/too long/);
  });

  it("doesn't time out a move that is answered, and stops its clock", async () => {
    vi.useFakeTimers();
    const card = item({ id: "item-1" });
    const moved = { ...card, status: "cooking" as const };
    const { deps: d, applied, said, poller } = deps(() =>
      Promise.resolve(new Response(JSON.stringify({ item: moved }), { status: 200 })),
    );
    await sendMove(card, "cooking", d);
    await vi.advanceTimersByTimeAsync(MOVE_TIMEOUT_MS * 2);
    expect(applied).toEqual([[moved]]);
    expect(said.at(-1)).toBeUndefined();
    expect(poller.refreshes).toBe(0);
  });

  it("keeps the spot of a timed-out move that did work held until a poll shows it, then for the moment after", async () => {
    vi.useFakeTimers();
    const guard = sameSpotGuard();
    const now = () => performance.now();
    const tap = (itemId: string) => ({ itemId, x: 300, y: 200, at: now(), fromPointer: true });
    const first = item({ id: "a" });
    let asked = 0;
    const shown: string[][] = [];
    const poller = startPolling({
      cursor: "1",
      fetch: async () => {
        asked = now();
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        return new Response(JSON.stringify({ cursor: "2", now: placedAt, items: [{ ...first, status: "cooking" }] }));
      },
      onChanges: (changes) => {
        shown.push(changes.items.map((it) => it.id));
        guard.polled(asked, now(), shown.at(-1)!);
      },
      onConnection: () => {},
    });
    expect(guard.allow(tap("a"))).toBe(true);
    const server = hung();
    const done = sendMove(first, "cooking", {
      ...deps(server.fetch).deps,
      poller,
      lost: () => guard.unanswered("a", now()),
    }).finally(() => guard.settled("a", now()));
    await vi.advanceTimersByTimeAsync(MOVE_TIMEOUT_MS);
    await done;
    shown.length = 0;
    expect(guard.allow(tap("a"))).toBe(true); // the item itself is free again
    guard.unanswered("a", now()); // ... and that retap never reached the server
    await vi.advanceTimersByTimeAsync(1_000);
    expect(guard.allow(tap("b"))).toBe(false); // past 0.6 s, but no poll has answered yet
    await vi.advanceTimersByTimeAsync(500);
    expect(shown).toEqual([["a"]]); // A slides away, 1.5 s after the timeout
    await vi.advanceTimersByTimeAsync(100);
    expect(guard.allow(tap("b"))).toBe(false);
    await vi.advanceTimersByTimeAsync(SAME_SPOT_MS);
    expect(guard.allow(tap("b"))).toBe(true);
    poller.stop();
  });

  it("marks the timeout before it polls", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const server = hung();
    const done = sendMove(item(), "cooking", {
      ...deps(server.fetch).deps,
      poller: { refresh: () => void order.push("poll") },
      lost: () => void order.push("lost"),
    });
    await vi.advanceTimersByTimeAsync(MOVE_TIMEOUT_MS);
    await done;
    expect(order).toEqual(["lost", "poll"]);
  });

  it("times out a void or reject too, says so and leaves the form to try again", async () => {
    vi.useFakeTimers();
    const server = hung();
    const { deps: d, said, poller } = deps(server.fetch);
    const done = sendVoid(item(), "Dropped it", d);
    await vi.advanceTimersByTimeAsync(MOVE_TIMEOUT_MS);
    expect(await done).toBe(false);
    expect(said.at(-1)).toMatch(/too long/);
    expect(poller.refreshes).toBe(1);
  });
});

describe("voiding and rejecting from the board", () => {
  const reply = (status: number, body?: unknown) =>
    Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status }));

  const sending = (respond: () => Promise<Response>) => {
    const applied: BoardItem[][] = [];
    const said: (string | undefined)[] = [];
    const requests: { url: string; body: FormData; headers?: Record<string, string> }[] = [];
    const poller = { refreshes: 0, refresh() { this.refreshes += 1; } };
    const deps = {
      fetch: (url: string, init: { method: string; body: FormData; headers?: Record<string, string> }) => {
        requests.push({ url, body: init.body, headers: init.headers });
        return respond();
      },
      apply: (items: BoardItem[]) => void applied.push(items),
      say: (message: string | undefined) => void said.push(message),
      poller,
    };
    return { deps, applied, said, requests, poller };
  };

  it("voids one item with its reason, and takes it off the board", async () => {
    const card = item({ id: "item-1" });
    const { deps, applied, requests } = sending(() => reply(204));

    expect(await sendVoid(card, "Nobody at the table", deps)).toBe(true);

    expect(requests[0].url).toBe("/api/order-items/item-1/void");
    expect(requests[0].body.get("reason")).toBe("Nobody at the table");
    expect(requests[0].headers).toEqual({ "x-form-fetch": "1" });
    expect(applied).toEqual([[{ ...card, status: "voided" }]]);
  });

  it("rejects the order with its reason, and takes every one of its items off the board", async () => {
    const first = item({ id: "item-1", orderId: "order-9" });
    const second = item({ id: "item-2", orderId: "order-9", status: "cooking" });
    const { deps, applied, requests } = sending(() => reply(204));

    expect(await sendReject(first, [first, second], "Nobody at the table", deps)).toBe(true);

    expect(requests[0].url).toBe("/api/orders/order-9/reject");
    expect(requests[0].body.get("reason")).toBe("Nobody at the table");
    expect(applied).toEqual([[{ ...first, status: "voided" }, { ...second, status: "voided" }]]);
  });

  it("on a refusal, says why, changes nothing and refreshes the board", async () => {
    const card = item();
    const { deps, applied, said, poller } = sending(() =>
      reply(409, { error: "This item is delivered, so it can't be voided." }),
    );

    expect(await sendVoid(card, "Late", deps)).toBe(false);

    expect(applied).toEqual([]);
    expect(said.at(-1)).toBe("This item is delivered, so it can't be voided.");
    expect(poller.refreshes).toBe(1);
  });

  it("says so when its answer is lost, changes nothing and refreshes the board, for it may have worked (#135)", async () => {
    const card = item();
    const { deps, applied, said, poller } = sending(() => Promise.reject(new Error("offline")));

    expect(await sendReject(card, [card], "Late", deps)).toBe(false);

    expect(applied).toEqual([]);
    expect(said.at(-1)).toMatch(/no clear answer/i);
    expect(poller.refreshes).toBe(1);
  });
});

describe("the card menu (#73)", () => {
  it("offers Void and Reject on a placed card, with nothing to move back", () => {
    expect(cardMenuActions("placed")).toEqual(["void", "reject"]);
  });

  it("offers Move back as well on cooking and done cards", () => {
    expect(cardMenuActions("cooking")).toEqual(["back", "void", "reject"]);
    expect(cardMenuActions("done")).toEqual(["back", "void", "reject"]);
  });

  it("takes a blank reason as no reason, so the form refuses it", () => {
    expect(voidReasonFrom("   ")).toBeNull();
    expect(voidReasonFrom("")).toBeNull();
  });

  it("finds every one of an order's items on the board, for a reject", () => {
    const first = item({ id: "a", orderId: "order-1" });
    const second = item({ id: "b", orderId: "order-1", status: "done" });
    const other = item({ id: "c", orderId: "order-2" });
    const board = new Map([first, second, other].map((it) => [it.id, it]));

    expect(itemsOfOrder(board, "order-1")).toEqual([first, second]);
    expect(itemsOfOrder(board, "order-3")).toEqual([]);
  });
});

describe("a double tap on one spot (#100)", () => {
  const tap = (itemId: string, at: number, x = 300, y = 200, fromPointer = true) => ({ itemId, x, y, at, fromPointer });

  it("refuses a second ticket's tap on the same spot straight after", () => {
    const guard = sameSpotGuard();
    expect(guard.allow(tap("a", 1000))).toBe(true);
    expect(guard.allow(tap("b", 1000 + 250, 305, 204))).toBe(false);
  });

  it("holds the spot while the move is in flight, then for a moment after it settles", () => {
    const guard = sameSpotGuard();
    expect(guard.allow(tap("a", 0))).toBe(true);
    expect(guard.allow(tap("b", 700))).toBe(false); // still in flight: a poll may have moved A already
    guard.settled("a", 800);
    expect(guard.allow(tap("b", 850))).toBe(false);
  });

  it("lets the next ticket through once the moment after the move has passed", () => {
    const guard = sameSpotGuard();
    guard.allow(tap("a", 0));
    guard.settled("a", 800);
    expect(guard.allow(tap("b", 800 + SAME_SPOT_MS))).toBe(true);
  });

  it("lets rapid work on a different spot through while a move is in flight", () => {
    const guard = sameSpotGuard();
    expect(guard.allow(tap("a", 0))).toBe(true);
    expect(guard.allow(tap("b", 200, 300, 330))).toBe(true);
    guard.settled("a", 800);
    expect(guard.allow(tap("c", 850, 900, 200))).toBe(true);
  });

  it("keeps one spot per move: settling one doesn't release another", () => {
    const guard = sameSpotGuard();
    guard.allow(tap("a", 0));
    guard.allow(tap("b", 200, 300, 330));
    guard.settled("b", 400);
    expect(guard.allow(tap("c", 1100))).toBe(false);
    expect(guard.allow(tap("c", 1100, 300, 330))).toBe(true);
  });

  it("guards the first spot even after a tap somewhere else", () => {
    const guard = sameSpotGuard();
    expect(guard.allow(tap("a", 0))).toBe(true);
    guard.settled("a", 50);
    expect(guard.allow(tap("c", 200, 900, 200))).toBe(true);
    expect(guard.allow(tap("b", 400))).toBe(false);
  });

  it("keeps the spot guarded through a triple tap", () => {
    const guard = sameSpotGuard();
    expect(guard.allow(tap("a", 0))).toBe(true);
    guard.settled("a", 10);
    expect(guard.allow(tap("b", 300))).toBe(false);
    expect(guard.allow(tap("b", 620))).toBe(false);
    expect(guard.allow(tap("b", 620 + SAME_SPOT_MS))).toBe(true);
  });

  it("lets a failed move's own item be tapped again straight away, and releases the spot", () => {
    const guard = sameSpotGuard();
    guard.allow(tap("a", 0));
    guard.settled("a", 300);
    expect(guard.allow(tap("a", 350))).toBe(true);
    guard.settled("a", 500);
    expect(guard.allow(tap("b", 500 + SAME_SPOT_MS))).toBe(true);
  });

  it("holds the spot of an unanswered move for 10 seconds at most", () => {
    const guard = sameSpotGuard();
    guard.allow(tap("a", 0));
    expect(guard.allow(tap("b", SAME_SPOT_HOLD_MS - 1))).toBe(false);
    expect(guard.allow(tap("b", SAME_SPOT_HOLD_MS))).toBe(true);
  });

  it("keeps a timed-out move's spot for a poll asked after it, not one already on its way (#101)", () => {
    const guard = sameSpotGuard();
    guard.allow(tap("a", 0));
    guard.unanswered("a", 8_000);
    guard.settled("a", 8_000);
    guard.polled(7_000, 8_500, []); // may have been read before the move was applied
    expect(guard.allow(tap("b", 9_500))).toBe(false);
    guard.polled(8_500, 10_000, ["a"]);
    expect(guard.allow(tap("b", 10_000 + SAME_SPOT_MS))).toBe(true);
  });

  it("holds a lost move's spot until a poll shows the board, however long polls fail (#135)", () => {
    const guard = sameSpotGuard();
    guard.allow(tap("a", 0));
    guard.unanswered("a", 100);
    guard.settled("a", 100);
    expect(guard.allow(tap("b", 100 + SAME_SPOT_HOLD_MS))).toBe(false);
    expect(guard.allow(tap("b", 600_000))).toBe(false);
    expect(guard.allow(tap("b", 600_100, 300, 330))).toBe(true); // other spots work through it
    guard.polled(601_000, 602_000, ["a"]); // the outage ends, and A slides now
    expect(guard.allow(tap("c", 602_050))).toBe(false);
    expect(guard.allow(tap("c", 602_050 + SAME_SPOT_MS))).toBe(true);
  });

  it("releases a lost move's spot when a retap of its item is answered, which shows the real state (#135)", () => {
    const guard = sameSpotGuard();
    guard.allow(tap("a", 0));
    guard.unanswered("a", 100);
    guard.allow(tap("a", 2_000));
    guard.shown("a", 2_200);
    guard.settled("a", 2_200);
    expect(guard.allow(tap("b", 2_300))).toBe(false);
    expect(guard.allow(tap("b", 2_300 + SAME_SPOT_MS))).toBe(true);
  });

  it("keeps the spot held when the retap is refused without saying where the item is, as when signed out (#135)", () => {
    const guard = sameSpotGuard();
    guard.allow(tap("a", 0));
    guard.unanswered("a", 100);
    guard.allow(tap("a", 2_000));
    guard.settled("a", 2_200);
    expect(guard.allow(tap("b", 60_000))).toBe(false);
  });

  it("keeps the spot held when the retap's answer is lost too (#135)", () => {
    const guard = sameSpotGuard();
    guard.allow(tap("a", 0));
    guard.unanswered("a", 100);
    guard.allow(tap("a", 2_000));
    guard.unanswered("a", 2_200);
    guard.settled("a", 2_200);
    expect(guard.allow(tap("b", 60_000))).toBe(false);
  });

  it("guards a lost move's spot again if it is applied only after the first poll was read (#135)", () => {
    const guard = sameSpotGuard();
    guard.allow(tap("a", 0));
    guard.unanswered("a", 100);
    guard.polled(101, 200, []); // the server was still at it
    guard.polled(5_200, 5_300, ["a"]); // A slides now
    expect(guard.allow(tap("b", 5_350))).toBe(false);
    expect(guard.allow(tap("b", 5_300 + SAME_SPOT_MS + 50))).toBe(true);
  });

  it("stops watching for a late move once polls have had 10 seconds, or have shown it (#135)", () => {
    const shown = sameSpotGuard();
    shown.allow(tap("a", 0));
    shown.unanswered("a", 100);
    shown.polled(200, 300, ["a"]);
    shown.polled(5_300, 5_400, ["a"]); // someone else's later move
    expect(shown.allow(tap("b", 5_450))).toBe(true);

    const failed = sameSpotGuard();
    failed.allow(tap("a", 0));
    failed.unanswered("a", 100);
    failed.polled(200, 300, []);
    failed.polled(100 + SAME_SPOT_HOLD_MS, 10_200, []);
    failed.polled(15_200, 15_300, ["a"]);
    expect(failed.allow(tap("b", 15_350))).toBe(true);
  });

  it("lets a steady tapper through in the end: ignored taps extend the guard to 1.2 s at most (#135)", () => {
    const guard = sameSpotGuard();
    guard.allow(tap("a", 0));
    guard.settled("a", 100);
    const accepted = [300, 600, 900, 1_200, 1_500].filter((at) => guard.allow(tap("b", at)));
    expect(accepted).toEqual([1_500]); // 100 + 2 × 0.6 s; B's own item, so nothing holds it after
  });

  it("is not released by a poll while its move may still be answered", () => {
    const guard = sameSpotGuard();
    guard.allow(tap("a", 0));
    guard.polled(100, 200, []);
    expect(guard.allow(tap("b", 2_000))).toBe(false);
  });

  it("never blocks an activation that isn't a pointer's", () => {
    const guard = sameSpotGuard();
    expect(guard.allow(tap("a", 1000))).toBe(true);
    expect(guard.allow(tap("b", 1100, 300, 200, false))).toBe(true);
    expect(guard.allow(tap("c", 1150))).toBe(false);
  });
});
