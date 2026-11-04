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

  it.each(["-1", "210.555", "2,10", "ZiG 210", "1e3", "NaN", "Infinity", "1000000000"])(
    "refuses the ZiG price %j",
    (priceZig) => {
      expect(parseNewMenuItem(form({ ...valid, priceZig }))).toMatchObject({
        success: false,
        message: "Enter the ZiG price as a number, like 210.",
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
