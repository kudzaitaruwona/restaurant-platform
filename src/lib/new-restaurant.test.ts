import { describe, expect, it } from "vitest";
import { timezoneChoices } from "./restaurant-settings";

describe("the timezones the New restaurant sheet offers", () => {
  it("has the default among them, sorted", () => {
    const choices = timezoneChoices();
    expect(choices).toContain("Africa/Harare");
    expect(choices).toEqual([...choices].sort());
  });

  it("are the same list the restaurant settings page offers", () => {
    expect(timezoneChoices()).toContain("UTC");
  });

  it("are worked out once, not on every render", () => {
    expect(timezoneChoices()).toBe(timezoneChoices());
  });
});
