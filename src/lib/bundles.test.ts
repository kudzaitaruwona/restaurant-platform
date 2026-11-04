import { describe, expect, it } from "vitest";
import { parseNewBundle } from "./bundles";
import { specialRefusal } from "./specials";

const form = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return body;
};

const categoryId = crypto.randomUUID();
const bundle = {
  name: "Burger + chips + drink",
  description: "Beef burger, a portion of chips and a 330ml soft drink.",
  priceUsd: "9.50",
  categoryId,
};

describe("parseNewBundle", () => {
  it("takes an item and its special's dates in one form", () => {
    expect(
      parseNewBundle(form({ ...bundle, title: " Lunch ", startDate: "2030-03-01", endDate: "2030-03-07" })),
    ).toEqual({
      success: true,
      data: {
        name: bundle.name,
        description: bundle.description,
        priceUsd: "9.50",
        priceZig: null,
        categoryId,
        title: "Lunch",
        startDate: "2030-03-01",
        endDate: "2030-03-07",
      },
    });
  });

  it("leaves the badge and both dates blank", () => {
    expect(parseNewBundle(form(bundle))).toMatchObject({
      success: true,
      data: { title: null, startDate: null, endDate: null },
    });
  });

  it("needs a description, because it lists what's included", () => {
    expect(parseNewBundle(form({ ...bundle, description: "   " }))).toEqual({
      success: false,
      message: "List what's included, in up to 1000 characters.",
    });
    const missing = form(bundle);
    missing.delete("description");
    expect(parseNewBundle(missing).success).toBe(false);
  });

  it("needs a price in some currency", () => {
    expect(parseNewBundle(form({ ...bundle, priceUsd: "" }))).toMatchObject({
      success: false,
      message: "Enter a USD price, a ZiG price, or both.",
    });
    expect(parseNewBundle(form({ ...bundle, priceUsd: "", priceZig: "200" })).success).toBe(true);
  });

  it("refuses an end date before the start date", () => {
    expect(
      parseNewBundle(form({ ...bundle, startDate: "2030-03-07", endDate: "2030-03-01" })),
    ).toMatchObject({ success: false, message: "The end date can't be before the start date." });
  });

  it("refuses a malformed date or a name that is blank", () => {
    expect(parseNewBundle(form({ ...bundle, startDate: "01/03/2030" })).success).toBe(false);
    expect(parseNewBundle(form({ ...bundle, name: " " })).success).toBe(false);
  });

  it("ignores what it wasn't asked for: visibility and restaurant come from the app", () => {
    const parsed = parseNewBundle(
      form({ ...bundle, visibility: "regular", restaurantId: crypto.randomUUID(), active: "false" }),
    );
    expect(parsed.success && Object.keys(parsed.data)).not.toContain("visibility");
    expect(parsed.success && Object.keys(parsed.data)).not.toContain("restaurantId");
  });
});

describe("specialRefusal", () => {
  it("names D-05's refusal and the empty window, and nothing else", () => {
    expect(specialRefusal({ cause: { code: "23P01" } })).toBe("overlap");
    expect(specialRefusal({ cause: { constraint: "specials_window_ordered" } })).toBe("already_over");
    expect(specialRefusal({ cause: { code: "23503" } })).toBeNull();
    expect(specialRefusal(new Error("boom"))).toBeNull();
  });
});
