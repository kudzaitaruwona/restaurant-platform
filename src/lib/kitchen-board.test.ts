import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ageOf,
  type BoardItem,
  applyChanges,
  arrivals,
  boardColumns,
  FLASH_MS,
  isMove,
  nextStatus,
  previousStatus,
  sendMove,
  sendReject,
  sendVoid,
  VOID_REASON_MAX,
  voidReasonFrom,
} from "./kitchen-board";

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

  it("doesn't count an item seen before as arriving again", () => {
    const seen = item({ id: "seen" });
    const result = applyChanges(new Map([[seen.id, seen]]), [seen]);
    expect(result.arrived).toEqual([]);
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

  it("says so when the move doesn't reach the server, and changes nothing", async () => {
    const card = item();
    const { deps, applied, said, poller } = moving(() => Promise.reject(new Error("offline")));

    await sendMove(card, "cooking", deps);

    expect(applied).toEqual([]);
    expect(said.at(-1)).toMatch(/didn't reach the server/);
    expect(poller.refreshes).toBe(0);
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

  it("says so when it doesn't reach the server, and changes nothing", async () => {
    const card = item();
    const { deps, applied, said } = sending(() => Promise.reject(new Error("offline")));

    expect(await sendReject(card, [card], "Late", deps)).toBe(false);

    expect(applied).toEqual([]);
    expect(said.at(-1)).toMatch(/didn't reach the server/);
  });
});
