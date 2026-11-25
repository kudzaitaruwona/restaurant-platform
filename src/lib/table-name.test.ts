import { expect, it } from "vitest";
import { tableName } from "./table-name";

it("says Table before a label that is only a number, and leaves every other label alone", () => {
  expect(tableName("7")).toBe("Table 7");
  expect(tableName("12b")).toBe("Table 12b");
  expect(tableName("Table 7")).toBe("Table 7");
  expect(tableName("T3")).toBe("T3");
  expect(tableName("Patio")).toBe("Patio");
  expect(tableName("2 by the door")).toBe("2 by the door");
});
