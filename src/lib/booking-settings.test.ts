import { describe, expect, it } from "vitest";
import {
  enableBlockedMessage,
  missingForBooking,
  parseBookingSettings,
  parseNewPeriod,
  parsePeriodEdit,
} from "./booking-settings";

const form = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return body;
};

const defaults = {
  slotIntervalMinutes: "15",
  sittingMinutes: "90",
  largePartySize: "5",
  largePartySittingMinutes: "120",
  bufferMinutes: "15",
  minLeadMinutes: "60",
  maxDaysAhead: "30",
  maxOnlinePartySize: "8",
  guestCancelCutoffMinutes: "120",
  maxActiveBookingsPerPhone: "2",
};

describe("parseBookingSettings", () => {
  it("reads every setting as a number", () => {
    expect(parseBookingSettings(form(defaults))).toEqual({
      success: true,
      data: {
        slotIntervalMinutes: 15,
        sittingMinutes: 90,
        largePartySize: 5,
        largePartySittingMinutes: 120,
        bufferMinutes: 15,
        minLeadMinutes: 60,
        maxDaysAhead: 30,
        maxOnlinePartySize: 8,
        guestCancelCutoffMinutes: 120,
        maxActiveBookingsPerPhone: 2,
      },
    });
  });

  it("takes zero where zero makes sense: no buffer, no lead time, today only", () => {
    const result = parseBookingSettings(
      form({ ...defaults, bufferMinutes: "0", minLeadMinutes: "0", maxDaysAhead: "0" }),
    );
    expect(result).toMatchObject({
      success: true,
      data: { bufferMinutes: 0, minLeadMinutes: 0, maxDaysAhead: 0 },
    });
  });

  it.each(["", "-1", "1.5", "1e1", "0x10", "abc", "NaN", "Infinity", " "])(
    "refuses %j for a setting",
    (value) => {
      expect(parseBookingSettings(form({ ...defaults, sittingMinutes: value }))).toMatchObject({
        success: false,
      });
    },
  );

  it.each([
    ["slotIntervalMinutes", "0"],
    ["slotIntervalMinutes", "241"],
    ["sittingMinutes", "721"],
    ["maxDaysAhead", "366"],
    ["maxOnlinePartySize", "0"],
    ["maxOnlinePartySize", "101"],
    ["maxActiveBookingsPerPhone", "0"],
    ["maxActiveBookingsPerPhone", "21"],
  ])("refuses %s = %s, outside what the database accepts", (key, value) => {
    expect(parseBookingSettings(form({ ...defaults, [key]: value }))).toMatchObject({
      success: false,
    });
  });

  it("refuses a form with one missing", () => {
    const rest: Partial<typeof defaults> = { ...defaults };
    delete rest.bufferMinutes;
    expect(parseBookingSettings(form(rest as Record<string, string>))).toMatchObject({
      success: false,
    });
  });

  it("never echoes the refused value back, and ignores a field it doesn't know", () => {
    const refused = parseBookingSettings(form({ ...defaults, bufferMinutes: "<script>" }));
    expect(JSON.stringify(refused)).not.toContain("<script>");

    const result = parseBookingSettings(
      form({ ...defaults, restaurantId: "someone else's", enabled: "true" }),
    );
    expect(result).toMatchObject({ success: true });
    expect(result.success && Object.keys(result.data)).not.toContain("enabled");
    expect(result.success && Object.keys(result.data)).not.toContain("restaurantId");
  });
});

const period = { name: "Lunch", weekday: "1", opensAt: "12:00", lastBookingAt: "14:00", closesAt: "15:00" };

describe("parseNewPeriod", () => {
  it("reads the name, weekday and times", () => {
    expect(parseNewPeriod(form(period))).toEqual({
      success: true,
      data: { name: "Lunch", weekday: 1, opensAt: "12:00", lastBookingAt: "14:00", closesAt: "15:00" },
    });
  });

  it("trims the name", () => {
    expect(parseNewPeriod(form({ ...period, name: "  Dinner " }))).toMatchObject({
      data: { name: "Dinner" },
    });
  });

  it.each(["", "   ", "x".repeat(51)])("refuses the name %j", (name) => {
    expect(parseNewPeriod(form({ ...period, name }))).toMatchObject({ success: false });
  });

  it.each(["", "7", "-1", "01", "x", "1.5"])("refuses the weekday %j", (weekday) => {
    expect(parseNewPeriod(form({ ...period, weekday }))).toMatchObject({ success: false });
  });

  it.each(["", "9:00", "24:00", "12:60", "12", "12:00:30", "noon", "-1:00"])(
    "refuses the time %j",
    (time) => {
      for (const key of ["opensAt", "lastBookingAt", "closesAt"]) {
        expect(parseNewPeriod(form({ ...period, [key]: time }))).toMatchObject({ success: false });
      }
    },
  );

  it("takes sunday and 23:59, the latest a period can close", () => {
    expect(
      parseNewPeriod(form({ ...period, weekday: "0", opensAt: "18:00", lastBookingAt: "22:00", closesAt: "23:59" })),
    ).toMatchObject({ success: true });
  });

  it("takes a last booking at opening time, as the database does", () => {
    expect(
      parseNewPeriod(form({ ...period, opensAt: "12:00", lastBookingAt: "12:00" })),
    ).toMatchObject({ success: true });
  });

  it.each([
    ["opening after the last booking", { opensAt: "15:00", lastBookingAt: "14:00", closesAt: "16:00" }],
    ["the last booking at closing time", { lastBookingAt: "15:00", closesAt: "15:00" }],
    ["closing before opening, as across midnight", { opensAt: "20:00", lastBookingAt: "22:00", closesAt: "01:00" }],
  ])("refuses %s", (_name, times) => {
    expect(parseNewPeriod(form({ ...period, ...times }))).toMatchObject({ success: false });
  });
});

describe("parsePeriodEdit", () => {
  it("reads the name and times, and no weekday: a period stays on its day", () => {
    expect(parsePeriodEdit(form({ ...period, weekday: "3" }))).toEqual({
      success: true,
      data: { name: "Lunch", opensAt: "12:00", lastBookingAt: "14:00", closesAt: "15:00" },
    });
  });

  it("refuses times out of order", () => {
    expect(parsePeriodEdit(form({ ...period, lastBookingAt: "15:00" }))).toMatchObject({
      success: false,
    });
  });
});

describe("missingForBooking", () => {
  it("lists what's missing, in the order the gate does", () => {
    expect(missingForBooking({ periods: 0, bookableTables: 0, contactPhone: null })).toEqual([
      "service_period",
      "table",
      "contact_phone",
    ]);
  });

  it("is empty when all three exist", () => {
    expect(missingForBooking({ periods: 1, bookableTables: 2, contactPhone: "+263771234567" })).toEqual([]);
  });

  it("counts each on its own", () => {
    expect(missingForBooking({ periods: 1, bookableTables: 0, contactPhone: "+1" })).toEqual(["table"]);
    expect(missingForBooking({ periods: 0, bookableTables: 3, contactPhone: "+1" })).toEqual(["service_period"]);
    expect(missingForBooking({ periods: 1, bookableTables: 3, contactPhone: null })).toEqual(["contact_phone"]);
  });
});

describe("enableBlockedMessage", () => {
  it("names everything missing", () => {
    const message = enableBlockedMessage(["service_period", "table", "contact_phone"]);
    expect(message).toContain("service period");
    expect(message).toContain("table");
    expect(message).toContain("contact phone");
  });
});
