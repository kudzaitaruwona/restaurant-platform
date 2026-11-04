import { describe, expect, it } from "vitest";
import {
  parseNewSpecial,
  parseSpecialActive,
  specialStatus,
  windowDates,
} from "./specials";

const form = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return body;
};

const menuItemId = crypto.randomUUID();

describe("parseNewSpecial", () => {
  it("takes an item and a price, with nothing else", () => {
    expect(parseNewSpecial(form({ menuItemId, priceUsd: "6.50" }))).toEqual({
      success: true,
      data: {
        menuItemId,
        title: null,
        priceUsd: "6.50",
        priceZig: null,
        startDate: null,
        endDate: null,
      },
    });
  });

  it("takes a badge alone", () => {
    expect(parseNewSpecial(form({ menuItemId, title: "  Taco Tuesday " }))).toMatchObject({
      success: true,
      data: { title: "Taco Tuesday", priceUsd: null, priceZig: null },
    });
  });

  it("takes both prices, dates and a badge", () => {
    expect(
      parseNewSpecial(
        form({
          menuItemId,
          title: "Happy hour",
          priceUsd: "6",
          priceZig: "150",
          startDate: "2026-11-30",
          endDate: "2026-12-02",
        }),
      ),
    ).toMatchObject({
      success: true,
      data: { startDate: "2026-11-30", endDate: "2026-12-02", priceZig: "150" },
    });
  });

  it("takes a one-day window", () => {
    expect(
      parseNewSpecial(
        form({ menuItemId, title: "x", startDate: "2026-11-30", endDate: "2026-11-30" }),
      ).success,
    ).toBe(true);
  });

  it.each([
    ["no item", { title: "x" }, "Choose an item."],
    ["an empty form", {}, "Choose an item."],
    ["neither a badge nor a price", { menuItemId }, "Enter a badge, a special price, or both."],
    ["a blank badge and no price", { menuItemId, title: "   " }, "Enter a badge, a special price, or both."],
    ["a badge over 80 characters", { menuItemId, title: "x".repeat(81) }, "Enter a badge of up to 80 characters, like Taco Tuesday."],
    ["a USD price that is not a number", { menuItemId, priceUsd: "NaN" }, "Enter the special USD price as a number, like 6.50."],
    ["a negative USD price", { menuItemId, priceUsd: "-1" }, "Enter the special USD price as a number, like 6.50."],
    ["an exponent price", { menuItemId, priceUsd: "1e3" }, "Enter the special USD price as a number, like 6.50."],
    ["a ZiG price that is not a number", { menuItemId, priceZig: "Infinity" }, "Enter the special ZiG price as a number, like 150."],
    ["a date that is not a date", { menuItemId, title: "x", startDate: "tomorrow" }, "Enter the date as year-month-day, like 2026-11-30."],
    ["a day that does not exist", { menuItemId, title: "x", endDate: "2026-02-30" }, "Enter the date as year-month-day, like 2026-11-30."],
    ["a month that does not exist", { menuItemId, title: "x", endDate: "2026-13-01" }, "Enter the date as year-month-day, like 2026-11-30."],
    ["an end before the start", { menuItemId, title: "x", startDate: "2026-12-02", endDate: "2026-12-01" }, "The end date can't be before the start date."],
  ])("refuses %s, with a fixed reason", (_name, fields, message) => {
    expect(parseNewSpecial(form(fields))).toEqual({ success: false, message });
  });

  it("does not echo what was typed", () => {
    const result = parseNewSpecial(form({ menuItemId, priceUsd: "<script>" }));
    expect(JSON.stringify(result)).not.toContain("script");
  });

  it("takes 29 February in a leap year only", () => {
    const base = { menuItemId, title: "x" };
    expect(parseNewSpecial(form({ ...base, endDate: "2028-02-29" })).success).toBe(true);
    expect(parseNewSpecial(form({ ...base, endDate: "2027-02-29" })).success).toBe(false);
  });
});

describe("parseSpecialActive", () => {
  it.each([
    ["true", true],
    ["false", false],
  ])("reads %s", (active, expected) => {
    expect(parseSpecialActive(form({ active }))).toEqual({ success: true, data: expected });
  });

  it.each(["", "yes", "1"])("refuses %j", (active) => {
    expect(parseSpecialActive(form({ active }))).toEqual({
      success: false,
      message: "Choose on or off.",
    });
  });
});

describe("windowDates", () => {
  // Africa/Harare is UTC+2 all year: a start date opens at 22:00 UTC the day before.
  const harare = "Africa/Harare";

  it("shows the dates the owner typed, from the stored instants", () => {
    expect(
      windowDates(
        {
          startsAt: new Date("2030-02-28T22:00:00Z"),
          endsAt: new Date("2030-03-07T22:00:00Z"),
        },
        harare,
      ),
    ).toEqual({ startDate: "2030-03-01", endDate: "2030-03-07" });
  });

  it("has no dates for no bounds", () => {
    expect(windowDates({ startsAt: null, endsAt: null }, harare)).toEqual({
      startDate: null,
      endDate: null,
    });
  });

  it("reads the date in the restaurant's zone, not the server's or UTC's", () => {
    // 23:30 UTC on the 28th is already the 1st in Harare, and still the 28th in London.
    const startsAt = new Date("2030-02-28T23:30:00Z");
    expect(windowDates({ startsAt, endsAt: null }, harare).startDate).toBe("2030-03-01");
    expect(windowDates({ startsAt, endsAt: null }, "Europe/London").startDate).toBe("2030-02-28");
  });
});

describe("specialStatus", () => {
  const starts = new Date("2030-02-28T22:00:00Z");
  const ends = new Date("2030-03-07T22:00:00Z");

  it("is live from the first instant of the window", () => {
    expect(specialStatus({ active: true, startsAt: starts, endsAt: ends }, starts)).toBe("live");
  });

  it("is not yet live a moment before", () => {
    expect(
      specialStatus({ active: true, startsAt: starts, endsAt: ends }, new Date(starts.getTime() - 1)),
    ).toBe("scheduled");
  });

  it("is live until the last moment before the end, and over at it", () => {
    expect(
      specialStatus({ active: true, startsAt: starts, endsAt: ends }, new Date(ends.getTime() - 1)),
    ).toBe("live");
    expect(specialStatus({ active: true, startsAt: starts, endsAt: ends }, ends)).toBe("ended");
  });

  it("is live with no end until turned off", () => {
    expect(specialStatus({ active: true, startsAt: starts, endsAt: null }, new Date("2099-01-01"))).toBe("live");
    expect(specialStatus({ active: false, startsAt: starts, endsAt: null }, new Date("2099-01-01"))).toBe("off");
  });

  it("is off whatever the dates say", () => {
    expect(specialStatus({ active: false, startsAt: starts, endsAt: ends }, starts)).toBe("off");
  });
});
