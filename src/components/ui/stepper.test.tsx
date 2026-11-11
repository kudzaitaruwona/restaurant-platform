import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Stepper, stepValue } from "./stepper";

describe("the stepper", () => {
  it("is a real number input that posts on its own, between labelled minus and plus buttons", () => {
    const html = renderToStaticMarkup(<Stepper name="partySize" defaultValue={2} min={1} max={100} aria-labelledby="ps" />);
    expect(html).toMatch(/<input[^>]*type="number"[^>]*name="partySize"/);
    expect(html.indexOf('aria-label="One fewer"')).toBeLessThan(html.indexOf("<input"));
    expect(html.indexOf('aria-label="One more"')).toBeGreaterThan(html.indexOf("<input"));
    expect(html.match(/<button type="button"/g)).toHaveLength(2);
  });

  it.each([
    ["2", 1, "3"],
    ["2", -1, "1"],
    ["1", -1, "1"],
    ["100", 1, "100"],
    ["", 1, "1"],
    ["abc", -1, "1"],
  ] as const)("steps %j by %i to %j, inside 1 to 100", (current, direction, next) => {
    expect(stepValue(current, direction, { min: 1, max: 100 })).toBe(next);
  });

  it("steps by the step given", () => {
    expect(stepValue("0.5", 1, { step: 0.5 })).toBe("1");
  });
});
