import { describe, expect, it } from "vitest";
import {
  parseAvailability,
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
    expect(parseNewMenuItem(form(valid))).toEqual({
      success: true,
      data: { ...valid, priceZig: null },
    });
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

  it.each(["-1", "8.555", "8,50", "$8", "abc", "1e3", "NaN", "Infinity", "1000000"])(
    "refuses the price %j, because the database would take some of these",
    (priceUsd) => {
      expect(parseNewMenuItem(form({ ...valid, priceUsd }))).toMatchObject({
        success: false,
      });
    },
  );

  it("takes a fixed ZiG price, with or without a USD one", () => {
    expect(parseNewMenuItem(form({ ...valid, priceZig: " 210 " }))).toMatchObject({
      success: true,
      data: { priceUsd: "8.50", priceZig: "210" },
    });
    expect(
      parseNewMenuItem(form({ ...valid, priceUsd: "", priceZig: "210.50" })),
    ).toMatchObject({ success: true, data: { priceUsd: null, priceZig: "210.50" } });
  });

  it("takes a ZiG-only item with no USD field sent at all", () => {
    const rest = { name: valid.name, description: "", categoryId };
    expect(parseNewMenuItem(form({ ...rest, priceZig: "210" }))).toMatchObject({
      success: true,
      data: { priceUsd: null, priceZig: "210" },
    });
  });

  it.each(["", "   "])("needs a price: %j is neither", (blank) => {
    expect(
      parseNewMenuItem(form({ ...valid, priceUsd: blank, priceZig: blank })),
    ).toEqual({ success: false, message: "Enter a USD price, a ZiG price, or both." });
  });

  it.each([
    ["-1", "The ZiG price can't be negative. Enter it like 210."],
    ["210.555", "The ZiG price can have at most 2 decimal places, like 210."],
    ["2,10", "The ZiG price uses a comma. Write a point for the decimal, like 210."],
    ["ZiG 210", "The ZiG price must be digits only, like 210: no currency sign, letters or spaces."],
    ["1e3", "The ZiG price must be digits only, like 210: no currency sign, letters or spaces."],
    ["NaN", "The ZiG price must be digits only, like 210: no currency sign, letters or spaces."],
    ["Infinity", "The ZiG price must be digits only, like 210: no currency sign, letters or spaces."],
    ["1000000000", "The ZiG price is too large. The most is 999,999,999.99."],
  ])("refuses the ZiG price %j, saying what is wrong", (priceZig, message) => {
    expect(parseNewMenuItem(form({ ...valid, priceZig }))).toEqual({ success: false, message });
  });

  it.each([
    ["1,000", "The USD price has a comma between thousands. Write it without, like 8.50."],
    ["1,000.50", "The USD price has a comma between thousands. Write it without, like 8.50."],
    ["12,345,678", "The USD price has a comma between thousands. Write it without, like 8.50."],
    ["0,500", "The USD price uses a comma. Write a point for the decimal, like 8.50."],
    [".5", "The USD price needs a digit on both sides of the point, like 8.50."],
    ["5.", "The USD price needs a digit on both sides of the point, like 8.50."],
    ["1,000.", "The USD price has a comma between thousands. Write it without, like 8.50."],
    ["1.000,50", "The USD price can have digits and one point for the decimal, nothing else, like 8.50."],
    ["1.2.3", "The USD price can have digits and one point for the decimal, nothing else, like 8.50."],
    ["$8.50", "The USD price must be digits only, like 8.50: no currency sign, letters or spaces."],
    ["8,50", "The USD price uses a comma. Write a point for the decimal, like 8.50."],
    ["-8", "The USD price can't be negative. Enter it like 8.50."],
    ["8.505", "The USD price can have at most 2 decimal places, like 8.50."],
    ["1000000", "The USD price is too large. The most is 999,999.99."],
  ])("refuses the USD price %j, saying what is wrong", (priceUsd, message) => {
    expect(parseNewMenuItem(form({ ...valid, priceUsd }))).toEqual({ success: false, message });
  });

  it("takes a zero price: asking first is the route's job", () => {
    expect(parseNewMenuItem(form({ ...valid, priceUsd: "0.00" }))).toMatchObject({
      success: true,
      data: { priceUsd: "0.00" },
    });
  });

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

describe("parseAvailability", () => {
  it.each([
    ["true", true],
    ["false", false],
  ])("reads %j as %s", (value, available) => {
    expect(parseAvailability(form({ available: value }))).toEqual({
      success: true,
      data: available,
    });
  });

  it.each(["", "yes", "1", "TRUE", "toggle"])("refuses %j", (value) => {
    expect(parseAvailability(form({ available: value }))).toMatchObject({
      success: false,
    });
  });

  it("refuses a form with no availability at all", () => {
    expect(parseAvailability(form({}))).toMatchObject({ success: false });
  });
});

describe("parseItemEdit", () => {
  const edit = { ...valid, sortOrder: "3" };

  it("takes the fields the editor shows", () => {
    expect(parseItemEdit(form(edit))).toEqual({
      success: true,
      data: { ...valid, priceZig: null, sortOrder: 3 },
    });
  });

  it("takes a fixed ZiG price, and reads a blank one as calculated", () => {
    expect(parseItemEdit(form({ ...edit, priceZig: " 210 " }))).toMatchObject({
      success: true,
      data: { priceZig: "210" },
    });
    expect(parseItemEdit(form({ ...edit, priceZig: "  " }))).toMatchObject({
      success: true,
      data: { priceZig: null },
    });
  });

  it("takes a ZiG price alone, with the USD price blank", () => {
    expect(parseItemEdit(form({ ...edit, priceUsd: "  ", priceZig: "210" }))).toMatchObject({
      success: true,
      data: { priceUsd: null, priceZig: "210" },
    });
  });

  it("needs at least one price, as the add form does", () => {
    expect(parseItemEdit(form({ ...edit, priceUsd: "", priceZig: "" }))).toEqual(
      parseNewMenuItem(form({ ...valid, priceUsd: "", priceZig: "" })),
    );
    expect(parseItemEdit(form({ ...edit, priceUsd: "", priceZig: "" }))).toMatchObject({
      success: false,
    });
  });

  it.each(["-1", "8.555", "1e3", "NaN", "Infinity", "1000000", "$8"])(
    "refuses the price %j",
    (priceUsd) => {
      expect(parseItemEdit(form({ ...edit, priceUsd }))).toMatchObject({ success: false });
    },
  );

  it.each(["-1", "8.555", "1e3", "NaN", "Infinity", "1000000000", "ZiG 210"])(
    "refuses the ZiG price %j",
    (priceZig) => {
      expect(parseItemEdit(form({ ...edit, priceZig }))).toMatchObject({ success: false });
    },
  );

  it.each(["0", "7", "9999", " 12 "])("takes the sort order %j", (sortOrder) => {
    expect(parseItemEdit(form({ ...edit, sortOrder }))).toMatchObject({
      success: true,
      data: { sortOrder: Number(sortOrder) },
    });
  });

  it("doesn't need a sort order: the editor moves items with Move up and Move down", () => {
    const result = parseItemEdit(form(valid));
    expect(result).toMatchObject({ success: true });
    expect(result.success && result.data.sortOrder).toBeUndefined();
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
