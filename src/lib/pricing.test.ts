import { describe, expect, it } from "vitest";
import {
  calculatedZigNote,
  effectiveUsd,
  effectiveZig,
  formatUsd,
  formatZig,
  priceDisplay,
  rateAge,
  rateAgeLabel,
} from "./pricing";

const pricing = { rate: "26.2", zigStep: "10", usdStep: "0.01" };
const noRate = { ...pricing, rate: null };

describe("effectiveZig", () => {
  it("rounds a calculated price up to the step: $8 at 26.2 is ZiG 210", () => {
    expect(effectiveZig({ priceUsd: "8", priceZig: null }, pricing)).toEqual({
      amount: "210",
      source: "calculated",
    });
  });

  it("keeps a price that already sits on the step", () => {
    // 5 * 26 = 130, exactly.
    expect(
      effectiveZig({ priceUsd: "5", priceZig: null }, { ...pricing, rate: "26" }),
    ).toMatchObject({ amount: "130" });
  });

  it("goes up for the smallest overshoot", () => {
    // 100 * 26.01 = 2601 -> 2610
    expect(
      effectiveZig({ priceUsd: "100", priceZig: null }, { ...pricing, rate: "26.01" }),
    ).toMatchObject({ amount: "2610" });
  });

  it("is exact where floating point is not", () => {
    // 1.1 * 10 is 11.000000000000002 in floating point, which would round up.
    expect(
      effectiveZig(
        { priceUsd: "1.1", priceZig: null },
        { rate: "10", zigStep: "1", usdStep: "0.01" },
      ),
    ).toMatchObject({ amount: "11" });
  });

  it("uses the restaurant's step", () => {
    expect(
      effectiveZig({ priceUsd: "8", priceZig: null }, { ...pricing, zigStep: "50" }),
    ).toMatchObject({ amount: "250" });
    expect(
      effectiveZig({ priceUsd: "8", priceZig: null }, { ...pricing, zigStep: "0.5" }),
    ).toMatchObject({ amount: "210" });
  });

  it("prefers a fixed ZiG price, untouched by the rate", () => {
    expect(
      effectiveZig({ priceUsd: "8", priceZig: "200" }, pricing),
    ).toEqual({ amount: "200", source: "fixed" });
    expect(effectiveZig({ priceUsd: null, priceZig: "200" }, noRate)).toEqual({
      amount: "200",
      source: "fixed",
    });
  });

  it("has nothing to calculate from without a rate", () => {
    expect(effectiveZig({ priceUsd: "8", priceZig: null }, noRate)).toBeNull();
  });

  it("is free when the USD price is", () => {
    expect(effectiveZig({ priceUsd: "0", priceZig: null }, pricing)).toMatchObject({
      amount: "0",
    });
  });
});

describe("effectiveUsd", () => {
  it("is the USD price when there is one", () => {
    expect(effectiveUsd({ priceUsd: "8.50", priceZig: "300" }, pricing)).toBe("8.50");
  });

  it("rounds a calculated price up to the cent: ZiG 210 at 26.2 is $8.02", () => {
    // 210 / 26.2 = 8.0152...
    expect(effectiveUsd({ priceUsd: null, priceZig: "210" }, pricing)).toBe("8.02");
  });

  it("keeps an exact cent", () => {
    expect(
      effectiveUsd({ priceUsd: null, priceZig: "130" }, { ...pricing, rate: "26" }),
    ).toBe("5");
  });

  it("has nothing to calculate from without a rate", () => {
    expect(effectiveUsd({ priceUsd: null, priceZig: "210" }, noRate)).toBeNull();
  });
});

describe("formatting", () => {
  it.each([
    ["8", "$8.00"],
    ["8.5", "$8.50"],
    ["8.02", "$8.02"],
    ["0", "$0.00"],
    ["1250", "$1,250.00"],
  ])("shows USD %s as %s", (value, shown) => {
    expect(formatUsd(value)).toBe(shown);
  });

  it.each([
    ["210", "ZiG 210"],
    ["210.00", "ZiG 210"],
    ["1200", "ZiG 1,200"],
    ["0.50", "ZiG 0.5"],
  ])("shows ZiG %s as %s", (value, shown) => {
    expect(formatZig(value)).toBe(shown);
  });
});

describe("priceDisplay", () => {
  const both = { priceUsd: "8", priceZig: null };

  it("usd_only shows the dollar price alone", () => {
    expect(priceDisplay(both, "usd_only", pricing)).toEqual({ main: "$8.00" });
  });

  it("zig_only shows the ZiG price alone, calculated if need be", () => {
    expect(priceDisplay(both, "zig_only", pricing)).toEqual({ main: "ZiG 210" });
  });

  it("both puts them on one line", () => {
    expect(priceDisplay(both, "both", pricing)).toEqual({ main: "$8.00 · ZiG 210" });
  });

  it("usd_primary puts the ZiG price underneath", () => {
    expect(priceDisplay(both, "usd_primary", pricing)).toEqual({
      main: "$8.00",
      sub: "ZiG 210",
    });
  });

  it("zig_primary puts the dollar price underneath", () => {
    expect(priceDisplay(both, "zig_primary", pricing)).toEqual({
      main: "ZiG 210",
      sub: "$8.00",
    });
  });

  it("shows a ZiG-only item in dollars too, rounded up to the cent", () => {
    expect(
      priceDisplay({ priceUsd: null, priceZig: "210" }, "usd_only", pricing),
    ).toEqual({ main: "$8.02" });
  });

  it("never shows a computed ZiG price unrounded", () => {
    const { main } = priceDisplay({ priceUsd: "7.77", priceZig: null }, "zig_only", pricing);
    // 7.77 * 26.2 = 203.574 -> 210
    expect(main).toBe("ZiG 210");
  });

  it("falls back to what it has until a rate is set", () => {
    expect(priceDisplay(both, "zig_only", noRate)).toEqual({ main: "$8.00" });
    expect(priceDisplay(both, "both", noRate)).toEqual({ main: "$8.00" });
    expect(priceDisplay(both, "usd_primary", noRate)).toEqual({ main: "$8.00" });
    expect(
      priceDisplay({ priceUsd: null, priceZig: "210" }, "usd_only", noRate),
    ).toEqual({ main: "ZiG 210" });
  });
});

describe("calculatedZigNote", () => {
  it("is the editor's live hint", () => {
    expect(calculatedZigNote("8", pricing)).toBe("Calculated: ZiG 210 at rate 26.2");
  });

  it("asks for a rate when there is none", () => {
    expect(calculatedZigNote("8", noRate)).toBe(
      "Set the exchange rate to calculate the ZiG price.",
    );
  });

  it.each(["", " ", "abc", "-1", "8.555"])("says nothing for the price %j", (usd) => {
    expect(calculatedZigNote(usd, pricing)).toBeNull();
  });
});

describe("rateAge", () => {
  const now = new Date("2026-11-10T12:00:00Z");
  const ago = (days: number, extraHours = 0) =>
    new Date(now.getTime() - (days * 24 + extraHours) * 3_600_000);

  it("counts whole days", () => {
    expect(rateAge(ago(0, 5), now).days).toBe(0);
    expect(rateAge(ago(3, 23), now).days).toBe(3);
  });

  it("is stale only past seven days", () => {
    expect(rateAge(ago(7), now).stale).toBe(false);
    expect(rateAge(ago(7, 1), now).stale).toBe(true);
    expect(rateAge(ago(30), now).stale).toBe(true);
  });

  it("is not negative if the clocks disagree", () => {
    expect(rateAge(ago(-1), now)).toEqual({ days: 0, stale: false });
  });

  it.each([
    [0, "today"],
    [1, "1 day ago"],
    [5, "5 days ago"],
  ])("labels %i days as %s", (days, label) => {
    expect(rateAgeLabel(days)).toBe(label);
  });
});
