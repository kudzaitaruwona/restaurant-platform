import { describe, expect, it } from "vitest";
import { parseNewExchangeRate } from "./exchange-rate";

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
    "",
    "   ",
    "0",
    "0.0",
    "0.000000",
    "-26",
    "26,2",
    "ZiG 26",
    "1e3",
    "NaN",
    "Infinity",
    "26.1234567",
    "1000000",
  ])("refuses %j with a reason", (usdToZig) => {
    expect(parseNewExchangeRate(form({ usdToZig }))).toEqual({
      success: false,
      message: "Enter the rate as a number above 0, like 26.2.",
    });
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
