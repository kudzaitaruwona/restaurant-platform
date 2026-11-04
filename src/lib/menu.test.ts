import { describe, expect, it } from "vitest";
import {
  formatUsd,
  parseCategoryOrder,
  parseItemEdit,
  parseNewCategory,
  parseNewMenuItem,
} from "./menu";

const form = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return body;
};

const categoryId = crypto.randomUUID();
const valid = {
  name: "Sadza and stew",
  description: "Slow-cooked beef",
  priceUsd: "8.50",
  categoryId,
};

describe("parseNewCategory", () => {
  it("trims the name", () => {
    expect(parseNewCategory(form({ name: "  Mains " }))).toEqual({
      success: true,
      data: { name: "Mains" },
    });
  });

  it.each(["", "   ", "x".repeat(201)])("refuses the name %j", (name) => {
    expect(parseNewCategory(form({ name }))).toMatchObject({ success: false });
  });

  it("refuses a form with no name", () => {
    expect(parseNewCategory(form({}))).toMatchObject({ success: false });
  });
});

describe("parseNewMenuItem", () => {
  it("takes a name, a description, a USD price and a category", () => {
    expect(parseNewMenuItem(form(valid))).toEqual({ success: true, data: valid });
  });

  it("takes no description", () => {
    expect(parseNewMenuItem(form({ ...valid, description: "" }))).toMatchObject({
      data: { description: "" },
    });
  });

  it.each(["8", "8.5", "8.50", "0", "0.99", "999999.99", " 12 "])(
    "takes the price %j",
    (priceUsd) => {
      expect(parseNewMenuItem(form({ ...valid, priceUsd }))).toMatchObject({
        success: true,
        data: { priceUsd: priceUsd.trim() },
      });
    },
  );

  it.each(["", "   ", "-1", "8.555", "8,50", "$8", "abc", "1e3", "NaN", "Infinity", "1000000"])(
    "refuses the price %j, because the database would take some of these",
    (priceUsd) => {
      expect(parseNewMenuItem(form({ ...valid, priceUsd }))).toMatchObject({
        success: false,
      });
    },
  );

  it.each([
    ["no name", { name: "" }],
    ["a blank name", { name: "   " }],
    ["a long name", { name: "x".repeat(201) }],
    ["a long description", { description: "x".repeat(1001) }],
    ["no category", { categoryId: "" }],
  ])("refuses %s", (_name, change) => {
    expect(parseNewMenuItem(form({ ...valid, ...change }))).toMatchObject({
      success: false,
    });
  });

  it("never echoes a refused value back", () => {
    const refused = parseNewMenuItem(form({ ...valid, priceUsd: "<script>" }));
    expect(refused).toMatchObject({ success: false });
    expect(JSON.stringify(refused)).not.toContain("<script>");
  });
});

describe("formatUsd", () => {
  it.each([
    ["8", "$8.00"],
    ["8.5", "$8.50"],
    ["0", "$0.00"],
    ["1250", "$1,250.00"],
  ])("shows %s as %s", (value, shown) => {
    expect(formatUsd(value)).toBe(shown);
  });
});

describe("parseItemEdit", () => {
  const edit = { ...valid, sortOrder: "3" };

  it("takes the fields the editor shows", () => {
    expect(parseItemEdit(form(edit))).toEqual({
      success: true,
      data: { ...valid, sortOrder: 3 },
    });
  });

  it("reads a blank USD price as none, for the database to judge", () => {
    expect(parseItemEdit(form({ ...edit, priceUsd: "  " }))).toMatchObject({
      success: true,
      data: { priceUsd: null },
    });
  });

  it.each(["-1", "8.555", "1e3", "NaN", "Infinity", "1000000", "$8"])(
    "refuses the price %j",
    (priceUsd) => {
      expect(parseItemEdit(form({ ...edit, priceUsd }))).toMatchObject({ success: false });
    },
  );

  it.each(["0", "7", "9999", " 12 "])("takes the sort order %j", (sortOrder) => {
    expect(parseItemEdit(form({ ...edit, sortOrder }))).toMatchObject({
      success: true,
      data: { sortOrder: Number(sortOrder) },
    });
  });

  it.each(["", "-1", "1.5", "10000", "abc", "1e2"])(
    "refuses the sort order %j",
    (sortOrder) => {
      expect(parseItemEdit(form({ ...edit, sortOrder }))).toMatchObject({ success: false });
    },
  );

  it.each([
    ["no name", { name: " " }],
    ["a long description", { description: "x".repeat(1001) }],
    ["no category", { categoryId: "" }],
  ])("refuses %s", (_name, change) => {
    expect(parseItemEdit(form({ ...edit, ...change }))).toMatchObject({ success: false });
  });
});

describe("parseCategoryOrder", () => {
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  const order = (values: string[]) => {
    const body = new FormData();
    for (const value of values) body.append("ids", value);
    return body;
  };

  it("keeps the order sent", () => {
    expect(parseCategoryOrder(order(ids))).toEqual({ success: true, data: ids });
  });

  it.each([
    ["no ids", []],
    ["a blank id", [ids[0], ""]],
    ["the same id twice", [ids[0], ids[0]]],
  ])("refuses %s", (_name, sent) => {
    expect(parseCategoryOrder(order(sent))).toMatchObject({ success: false });
  });
});
