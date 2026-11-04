import { describe, expect, it } from "vitest";
import { parseDirection, parseNewTable, parseTableEdit } from "./tables";

const form = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return body;
};

describe("parseNewTable", () => {
  it("trims the label and reads the capacity as a number", () => {
    expect(parseNewTable(form({ label: "  Patio 1 ", capacity: "4" }))).toEqual({
      success: true,
      data: { label: "Patio 1", capacity: 4 },
    });
  });

  it.each(["", "   ", "x".repeat(51)])("refuses the label %j", (label) => {
    expect(parseNewTable(form({ label, capacity: "4" }))).toMatchObject({
      success: false,
    });
  });

  it.each(["", "0", "-1", "1.5", "1e1", "0x10", "abc", "101", "NaN", "Infinity"])(
    "refuses the capacity %j",
    (capacity) => {
      expect(parseNewTable(form({ label: "7", capacity }))).toMatchObject({
        success: false,
      });
    },
  );

  it("refuses a form with either missing", () => {
    expect(parseNewTable(form({ capacity: "4" }))).toMatchObject({ success: false });
    expect(parseNewTable(form({ label: "7" }))).toMatchObject({ success: false });
  });

  it("never echoes the refused value back", () => {
    const result = parseNewTable(form({ label: "7", capacity: "<script>" }));
    expect(JSON.stringify(result)).not.toContain("<script>");
  });
});

describe("parseTableEdit", () => {
  it("reads the label, capacity and bookable flag", () => {
    expect(parseTableEdit(form({ label: " Bar ", capacity: "2", bookable: "false" }))).toEqual({
      success: true,
      data: { label: "Bar", capacity: 2, bookable: false },
    });
    expect(parseTableEdit(form({ label: "7", capacity: "4", bookable: "true" }))).toMatchObject({
      success: true,
      data: { bookable: true },
    });
  });

  it("takes the last bookable when the form sends two, as a ticked box does", () => {
    const body = new FormData();
    body.append("label", "7");
    body.append("capacity", "4");
    body.append("bookable", "false");
    body.append("bookable", "true");
    expect(parseTableEdit(body)).toMatchObject({ success: true, data: { bookable: true } });
  });

  it.each(["", "yes", "on", "1"])("refuses the bookable value %j", (bookable) => {
    expect(parseTableEdit(form({ label: "7", capacity: "4", bookable }))).toMatchObject({
      success: false,
    });
  });

  it("keeps the label 1-50 and the capacity 1-100", () => {
    const ok = { bookable: "true" };
    expect(parseTableEdit(form({ ...ok, label: "x".repeat(50), capacity: "100" }))).toMatchObject({ success: true });
    expect(parseTableEdit(form({ ...ok, label: "x".repeat(51), capacity: "4" }))).toMatchObject({ success: false });
    expect(parseTableEdit(form({ ...ok, label: " ", capacity: "4" }))).toMatchObject({ success: false });
    expect(parseTableEdit(form({ ...ok, label: "7", capacity: "101" }))).toMatchObject({ success: false });
    expect(parseTableEdit(form({ ...ok, label: "7", capacity: "0" }))).toMatchObject({ success: false });
  });
});

describe("parseDirection", () => {
  it("takes up and down only", () => {
    expect(parseDirection(form({ direction: "up" })).success).toBe(true);
    expect(parseDirection(form({ direction: "down" })).success).toBe(true);
    expect(parseDirection(form({ direction: "sideways" })).success).toBe(false);
    expect(parseDirection(form({})).success).toBe(false);
  });
});
