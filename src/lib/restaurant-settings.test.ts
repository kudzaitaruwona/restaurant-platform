import { describe, expect, it } from "vitest";
import {
  isTimeZone,
  parseRestaurantSettings,
  timeZoneNames,
  timeZoneOptions,
} from "./restaurant-settings";

const valid = {
  name: "Mama's Kitchen",
  contactPhone: "+263771234567",
  wifiName: "Mamas Guest",
  wifiPassword: "sadza-and-stew",
  currencyMode: "both",
  timezone: "Africa/Harare",
};

function parse(overrides: Record<string, string> = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries({ ...valid, ...overrides })) {
    form.set(key, value);
  }
  return parseRestaurantSettings(form);
}

describe("parseRestaurantSettings", () => {
  it("accepts a complete form", () => {
    expect(parse()).toEqual({ success: true, data: valid });
  });

  it("drops anything that isn't a setting, such as a smuggled restaurant id", () => {
    expect(parse({ restaurantId: "b", id: "b", slug: "taken" })).toEqual({
      success: true,
      data: valid,
    });
  });

  it("trims the name", () => {
    expect(parse({ name: "  Mama's  " })).toMatchObject({ data: { name: "Mama's" } });
  });

  it.each(["", "   ", "x".repeat(201)])("refuses the name %j", (name) => {
    expect(parse({ name })).toMatchObject({ success: false });
  });

  it("stores a blank optional field as nothing", () => {
    expect(
      parse({ contactPhone: " ", wifiName: "", wifiPassword: "" }),
    ).toMatchObject({
      data: { contactPhone: null, wifiName: null, wifiPassword: null },
    });
  });

  it.each([
    ["+263 77 123 4567", "+263771234567"],
    ["+263-77-123-4567", "+263771234567"],
  ])("saves %j in E.164", (typed, stored) => {
    expect(parse({ contactPhone: typed })).toMatchObject({
      data: { contactPhone: stored },
    });
  });

  it.each([
    "0771234567", // national format
    "263771234567", // no plus
    "+063771234567", // no country code starts with 0
    "+2637712345678901", // 16 digits
    "+26377123abc",
    "+",
  ])("refuses the phone number %j", (contactPhone) => {
    expect(parse({ contactPhone })).toMatchObject({ success: false });
  });

  it("keeps a Wi-Fi password exactly as typed: spaces can be part of it", () => {
    expect(parse({ wifiPassword: " two words " })).toMatchObject({
      data: { wifiPassword: " two words " },
    });
  });

  it.each(["usd_only", "zig_only", "usd_primary", "zig_primary", "both"])(
    "accepts the currency mode %s",
    (currencyMode) => {
      expect(parse({ currencyMode })).toMatchObject({ data: { currencyMode } });
    },
  );

  it("refuses an unknown currency mode", () => {
    expect(parse({ currencyMode: "gold" })).toMatchObject({ success: false });
  });

  it.each(["Africa/Johannesburg", "Europe/London", "UTC"])(
    "accepts the timezone %s",
    (timezone) => {
      expect(parse({ timezone })).toMatchObject({ data: { timezone } });
    },
  );

  // Real names this runtime's list leaves out, so a restaurant can hold them.
  it.each([
    "Asia/Kolkata",
    "Europe/Kyiv",
    "US/Eastern",
    "Etc/UTC",
    "GMT",
    "Etc/GMT+2",
  ])("accepts the alias %s, which the list needn't have", (timezone) => {
    expect(parse({ timezone })).toMatchObject({ data: { timezone } });
  });

  it.each(["Mars/Olympus", "africa/harare", "AFRICA/HARARE", "+02:00", "CAT", ""])(
    "refuses the timezone %j",
    (timezone) => {
      expect(parse({ timezone })).toMatchObject({ success: false });
    },
  );

  it("offers the default timezone", () => {
    expect(timeZoneNames).toContain("Africa/Harare");
  });

  it("accepts every timezone it offers, whatever this runtime's list holds", () => {
    expect(timeZoneNames.filter((zone) => !isTimeZone(zone))).toEqual([]);
  });

  it("offers a stored timezone that isn't on the list, in order", () => {
    const options = timeZoneOptions("US/Eastern");
    expect(options).toContain("US/Eastern");
    expect(options).toEqual([...options].sort());
  });

  it("offers each timezone once", () => {
    expect(timeZoneOptions("Africa/Harare")).toEqual(timeZoneNames);
  });

  it("refuses a form with a field missing, rather than blanking it", () => {
    const form = new FormData();
    form.set("name", "Mama's Kitchen");
    expect(parseRestaurantSettings(form)).toMatchObject({ success: false });
  });

  it("never repeats what was typed in the message", () => {
    const result = parse({
      wifiPassword: "secret-password".repeat(20),
      contactPhone: "secret-phone",
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain("secret-");
  });
});
