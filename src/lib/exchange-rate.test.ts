import { describe, expect, it } from "vitest";
import { parseNewExchangeRate, rateChangeWarning } from "./exchange-rate";

const form = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return body;
};

describe("parseNewExchangeRate", () => {
  it.each([
    ["26.2", "26.2"],
    [" 26.2 ", "26.2"],
    ["26.20", "26.2"],
    ["26.00", "26"],
    ["100", "100"],
    ["100.0", "100"],
    ["0.5", "0.5"],
    ["1234.567891", "1234.567891"],
  ])("takes %j as %j", (usdToZig, stored) => {
    expect(parseNewExchangeRate(form({ usdToZig }))).toEqual({
      success: true,
      data: { usdToZig: stored },
    });
  });

  it.each([
    ["", "Enter the rate as a number above 0, like 26.2."],
    ["   ", "Enter the rate as a number above 0, like 26.2."],
    ["0", "The rate must be above 0, like 26.2."],
    ["0.0", "The rate must be above 0, like 26.2."],
    ["0.000000", "The rate must be above 0, like 26.2."],
    ["-26", "The rate can't be negative. Enter it like 26.2."],
    ["26,2", "The rate uses a comma. Write a point for the decimal, like 26.2."],
    ["ZiG 26", "The rate must be digits only, like 26.2: no currency sign, letters or spaces."],
    ["1e3", "The rate must be digits only, like 26.2: no currency sign, letters or spaces."],
    ["NaN", "The rate must be digits only, like 26.2: no currency sign, letters or spaces."],
    ["Infinity", "The rate must be digits only, like 26.2: no currency sign, letters or spaces."],
    ["26.1234567", "The rate can have at most 6 decimal places, like 26.2."],
    ["1000000", "The rate is too large. The most is 999,999.999999."],
  ])("refuses %j, saying what is wrong", (usdToZig, message) => {
    expect(parseNewExchangeRate(form({ usdToZig }))).toEqual({ success: false, message });
  });

  it("refuses a form with no rate", () => {
    expect(parseNewExchangeRate(form({}))).toMatchObject({ success: false });
  });

  it("never echoes a refused value back", () => {
    expect(JSON.stringify(parseNewExchangeRate(form({ usdToZig: "<script>" })))).not.toContain(
      "<script>",
    );
  });
});

describe("rateChangeWarning", () => {
  it.each([
    ["26.2", "2620", "from 26.2 to 2620, up 9,900%"],
    ["26.2", "2.62", "from 26.2 to 2.62, down 90%"],
    ["26.2", "40", "from 26.2 to 40, up 53%"],
    ["26.2", "13", "from 26.2 to 13, down 50%"],
  ])("asks about %s to %s", (previous, next, words) => {
    // 13 is just under half of 26.2, so it asks; the others are far over.
    expect(rateChangeWarning(previous, next)).toContain(words);
  });

  it.each([
    ["26.2", "26.2"],
    ["26.2", "30"],
    ["26.2", "39"],
    ["26.2", "13.1"],
  ])("lets %s to %s through", (previous, next) => {
    expect(rateChangeWarning(previous, next)).toBeNull();
  });

  it("has nothing to compare with before the first rate", () => {
    expect(rateChangeWarning(null, "26.2")).toBeNull();
  });
});
