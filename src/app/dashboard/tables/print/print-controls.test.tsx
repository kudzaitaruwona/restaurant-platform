import { describe, expect, it } from "vitest";
import { pickTable } from "./print-controls";

describe("pickTable", () => {
  it("ticking a table under 'all' switches to the selected scope", () => {
    expect(pickTable({ scope: "all", ids: [] }, "a", true)).toEqual({ scope: "selected", ids: ["a"] });
  });
  it("unticking keeps the scope and drops the id", () => {
    expect(pickTable({ scope: "selected", ids: ["a", "b"] }, "a", false)).toEqual({
      scope: "selected",
      ids: ["b"],
    });
  });
  it("ticking twice doesn't duplicate", () => {
    expect(pickTable({ scope: "selected", ids: ["a"] }, "a", true).ids).toEqual(["a"]);
  });
});
