import { describe, expect, it } from "vitest";
import { parseNewTable } from "./tables";

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
