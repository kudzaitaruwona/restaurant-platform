import { describe, expect, it } from "vitest";
import {
  ageOf,
  type BoardItem,
  applyChanges,
  boardColumns,
  isMove,
  nextStatus,
  previousStatus,
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
