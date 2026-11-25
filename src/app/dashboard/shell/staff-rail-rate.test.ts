import { describe, expect, it } from "vitest";
import { showsRate } from "./nav";

const none = { value: null, age: null, stale: false };
const set = { value: "26.8", age: "today", stale: false };

describe("when the rail shows the exchange rate", () => {
  it("says nothing to a USD-only restaurant with no rate: there is nothing to set", () => {
    expect(showsRate(none, "usd_only")).toBe(false);
  });

  it("still warns every restaurant that shows ZiG and has no rate", () => {
    for (const mode of ["zig_only", "usd_primary", "zig_primary", "both"]) {
      expect(showsRate(none, mode)).toBe(true);
    }
  });

  it("shows a rate that was set, whatever the mode", () => {
    expect(showsRate(set, "usd_only")).toBe(true);
  });
});
