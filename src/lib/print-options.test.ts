import { describe, expect, it } from "vitest";
import { parsePrintOptions } from "./print-options";

const id = "123e4567-e89b-42d3-a456-426614174000";

describe("parsePrintOptions", () => {
  it("defaults to every table, no menu card, password on", () => {
    expect(parsePrintOptions()).toEqual({
      scope: "all",
      tableIds: [],
      menuCard: false,
      wifiPassword: true,
    });
  });

  it("reads selected tables, one or several, once each", () => {
    expect(parsePrintOptions({ scope: "selected", table: id }).tableIds).toEqual([id]);
    const other = id.replace("1", "2");
    expect(parsePrintOptions({ scope: "selected", table: [id, other, id] }).tableIds).toEqual([id, other]);
  });

  it("drops anything that isn't a uuid", () => {
    expect(parsePrintOptions({ scope: "selected", table: ["1", "' or 1=1", id] }).tableIds).toEqual([id]);
  });

  it("treats an unknown scope as all", () => {
    expect(parsePrintOptions({ scope: "everything" }).scope).toBe("all");
  });

  it("reads the menu card and the password switch", () => {
    const options = parsePrintOptions({ menu: "1", nopassword: "1" });
    expect(options.menuCard).toBe(true);
    expect(options.wifiPassword).toBe(false);
  });
});
