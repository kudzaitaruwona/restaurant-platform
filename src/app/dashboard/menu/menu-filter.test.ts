import { describe, expect, it } from "vitest";
import { matchesQuery, unfolded } from "./menu-filter";

describe("the menu finder's match (#113)", () => {
  it.each([
    ["Beef Stew", "beef", true],
    ["Beef Stew", "STEW", true],
    ["Beef Stew", "f s", true],
    ["Beef Stew", "  stew ", true],
    ["Beef Stew", "", true],
    ["Beef Stew", "   ", true],
    ["Beef Stew", "pork", false],
    ["Chips (large)", "(", true],
    ["Chips", ".", false],
  ])("%j against %j is %s", (name, query, expected) => {
    expect(matchesQuery(name, query)).toBe(expected);
  });
});

describe("a jump link's fold (#113)", () => {
  it("opens the category it jumps to and leaves the rest folded", () => {
    expect([...unfolded(new Set(["a", "b"]), "a")]).toEqual(["b"]);
  });

  it("changes nothing when that category is open", () => {
    const now = new Set(["b"]);
    expect(unfolded(now, "a")).toBe(now);
  });
});
