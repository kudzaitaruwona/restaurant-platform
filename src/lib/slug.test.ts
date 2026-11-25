import { describe, expect, it } from "vitest";
import { slugFrom } from "./slug";

describe("slugFrom", () => {
  it.each([
    ["Mama's Kitchen", "mamas-kitchen"],
    ["Chipo’s Café", "chipos-cafe"],
    ["Chipo‘s", "chipos"],
    ["Tom & Jerry's  Grill", "tom-jerrys-grill"],
    ["  --Braai House--  ", "braai-house"],
    ["!!!", ""],
  ])("makes %j into %j", (name, slug) => {
    expect(slugFrom(name)).toBe(slug);
  });

  it("stops at 63 characters without a trailing hyphen", () => {
    const slug = slugFrom(`${"a".repeat(62)} b`);
    expect(slug).toHaveLength(62);
    expect(slug.endsWith("-")).toBe(false);
  });
});
