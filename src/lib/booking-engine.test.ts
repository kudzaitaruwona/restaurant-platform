import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addDays,
  availableTimes,
  bookableDates,
  candidateTimes,
  dateLabel,
  type EngineTable,
  type Hold,
  holdFor,
  instantOf,
  isLocalDate,
  localTime,
  localToday,
  nearestTimes,
  type Period,
  type Rules,
  sittingFor,
  tablesFor,
  weekdayOf,
} from "./booking-engine";

const HARARE = "Africa/Harare"; // UTC+2, no daylight saving

const rules: Rules = {
  enabled: true,
  slotIntervalMinutes: 30,
  sittingMinutes: 90,
  largePartySize: 5,
  largePartySittingMinutes: 120,
  bufferMinutes: 15,
  minLeadMinutes: 60,
  maxDaysAhead: 30,
  maxOnlinePartySize: 8,
};

const everyDay = (name: string, opensAt: string, lastBookingAt: string): Period[] =>
  [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ name, weekday, opensAt, lastBookingAt }));

const periods = [
  ...everyDay("Lunch", "12:00:00", "13:00:00"),
  ...everyDay("Dinner", "18:00:00", "19:00:00"),
];

const table = (id: string, capacity: number, more: Partial<EngineTable> = {}): EngineTable => ({
  id,
  capacity,
  bookable: true,
  sortOrder: 0,
  archivedAt: null,
  ...more,
});

// 2026-11-05 is a Thursday. 08:00 in Harare.
const now = new Date("2026-11-05T06:00:00Z");
const date = "2026-11-06";

const input = {
  party: 2,
  date,
  rules,
  periods,
  tables: [table("t1", 2)],
  holds: [] as Hold[],
  timezone: HARARE,
  now,
};

const shown = (overrides: Partial<typeof input> = {}) =>
  availableTimes({ ...input, ...overrides }).map((slot) => slot.time);

const hold = (startsAt: string, holdEndsAt: string, status = "confirmed"): Hold => ({
  tableId: "t1",
  startsAt: new Date(startsAt),
  holdEndsAt: new Date(holdEndsAt),
  status,
});

describe("local dates", () => {
  it.each(["2026-02-28", "2024-02-29", "2026-12-31"])("takes %s", (value) => {
    expect(isLocalDate(value)).toBe(true);
  });

  it.each(["2026-02-31", "2026-02-29", "2026-13-01", "26-11-05", "2026-11-05T00:00", "", "tomorrow"])(
    "refuses %j",
    (value) => {
      expect(isLocalDate(value)).toBe(false);
    },
  );

  it("adds days across a month and a year", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
  });

  it("numbers the weekday from Sunday", () => {
    expect(weekdayOf("2026-11-08")).toBe(0);
    expect(weekdayOf("2026-11-05")).toBe(4);
  });
});

/**
 * The same computation must come out the same wherever the server is. Every
 * expectation here is written by hand in Harare time, and runs with the process in
 * UTC, in Harare, and far from both.
 */
describe.each(["UTC", HARARE, "Pacific/Auckland", "America/Los_Angeles"])(
  "with the server's timezone set to %s",
  (serverZone) => {
    const original = process.env.TZ;
    beforeAll(() => {
      process.env.TZ = serverZone;
    });
    afterAll(() => {
      process.env.TZ = original;
    });

    it("really is running in that zone", () => {
      const offset = new Date("2026-11-05T12:00:00Z").getTimezoneOffset();
      expect(offset).toBe({ UTC: 0, [HARARE]: -120, "Pacific/Auckland": -780, "America/Los_Angeles": 480 }[serverZone]);
    });

    it("turns a Harare wall clock into the right instant", () => {
      expect(instantOf("2026-11-06", "18:00", HARARE)).toEqual(new Date("2026-11-06T16:00:00Z"));
      expect(instantOf("2026-11-06", "00:00", HARARE)).toEqual(new Date("2026-11-05T22:00:00Z"));
    });

    it("reads an instant back on Harare's clock", () => {
      expect(localTime(new Date("2026-11-05T22:30:00Z"), HARARE)).toBe("00:30");
    });

    it("is already tomorrow in Harare at 22:00 UTC, and still today a minute before", () => {
      expect(localToday(new Date("2026-11-05T21:59:00Z"), HARARE)).toBe("2026-11-05");
      expect(localToday(new Date("2026-11-05T22:00:00Z"), HARARE)).toBe("2026-11-06");
    });

    it("gives a date's weekday by the calendar, whatever the instant", () => {
      // Friday, in Harare, at 00:30, which is still Thursday in UTC.
      const justAfterMidnight = new Date("2026-11-05T22:30:00Z");
      const onlyFridays = [{ name: "Friday", weekday: 5, opensAt: "18:00", lastBookingAt: "18:00" }];
      const today = localToday(justAfterMidnight, HARARE);
      expect(
        candidateTimes({ date: today, rules, periods: onlyFridays, timezone: HARARE, now: justAfterMidnight })
          .map((slot) => slot.time),
      ).toEqual(["18:00"]);
    });

    it("offers today and the last bookable day, and neither side of them", () => {
      const justAfterMidnight = new Date("2026-11-05T22:30:00Z"); // 6 Nov in Harare
      const on = (day: string) =>
        availableTimes({ ...input, date: day, now: justAfterMidnight }).length;

      expect(on("2026-11-05")).toBe(0); // yesterday in Harare, today in UTC
      expect(on("2026-11-06")).toBeGreaterThan(0);
      expect(on("2026-12-06")).toBeGreaterThan(0); // today + 30
      expect(on("2026-12-07")).toBe(0);
    });

    it("moves the last bookable day at Harare's midnight, not the server's", () => {
      const before = new Date("2026-11-05T21:59:00Z");
      const after = new Date("2026-11-05T22:01:00Z");
      const on = (at: Date) => availableTimes({ ...input, date: "2026-12-06", now: at }).length;

      expect(on(before)).toBe(0);
      expect(on(after)).toBeGreaterThan(0);
    });

    it("computes exactly the slots written out by hand", () => {
      expect(
        availableTimes({ ...input, date: "2026-12-05" }).map(({ period, time, startsAt }) => [
          period,
          time,
          startsAt.toISOString(),
        ]),
      ).toEqual([
        ["Lunch", "12:00", "2026-12-05T10:00:00.000Z"],
        ["Lunch", "12:30", "2026-12-05T10:30:00.000Z"],
        ["Lunch", "13:00", "2026-12-05T11:00:00.000Z"],
        ["Dinner", "18:00", "2026-12-05T16:00:00.000Z"],
        ["Dinner", "18:30", "2026-12-05T16:30:00.000Z"],
        ["Dinner", "19:00", "2026-12-05T17:00:00.000Z"],
      ]);
    });

    it("labels a date by the calendar", () => {
      expect(dateLabel("2026-11-06")).toBe("Fri 6 Nov");
    });
  },
);

describe("candidate times", () => {
  it("runs from opening to the last booking time, inclusive, by the slot interval", () => {
    expect(shown({ periods: everyDay("Dinner", "18:00", "19:00") })).toEqual([
      "18:00",
      "18:30",
      "19:00",
    ]);
  });

  it("stops at the last booking time when the interval doesn't land on it", () => {
    expect(
      shown({
        periods: everyDay("Dinner", "18:00", "19:10"),
        rules: { ...rules, slotIntervalMinutes: 45 },
      }),
    ).toEqual(["18:00", "18:45"]);
  });

  it("has only the weekday's periods", () => {
    const fridays: Period[] = [{ name: "Dinner", weekday: 5, opensAt: "18:00", lastBookingAt: "18:00" }];
    expect(shown({ date: "2026-11-06", periods: fridays })).toEqual(["18:00"]);
    expect(shown({ date: "2026-11-07", periods: fridays })).toEqual([]);
  });

  it("drops times inside the lead time, keeping the one exactly on it", () => {
    // 11:00 in Harare, so 12:00 is exactly an hour away.
    const at = new Date("2026-11-06T09:00:00Z");
    expect(shown({ now: at })).toContain("12:00");

    const aMinuteLater = new Date("2026-11-06T09:01:00Z");
    expect(shown({ now: aMinuteLater })).not.toContain("12:00");
    expect(shown({ now: aMinuteLater })).toContain("12:30");
  });
});

describe("bookable dates", () => {
  const dates = (overrides: Partial<Parameters<typeof bookableDates>[0]> = {}) =>
    bookableDates({ rules, periods, timezone: HARARE, now, ...overrides });

  it("runs from local today to max_days_ahead, inclusive", () => {
    const all = dates();
    expect(all).toHaveLength(31);
    expect(all[0].date).toBe("2026-11-05");
    expect(all.at(-1)?.date).toBe("2026-12-05");
  });

  it("closes a date with no service period", () => {
    const sundaysOnly = periods.filter((period) => period.weekday === 0);
    const open = dates({ periods: sundaysOnly }).filter((day) => day.open);
    expect(open.map((day) => weekdayOf(day.date))).toEqual(open.map(() => 0));
    expect(open.length).toBeGreaterThan(0);
  });

  it("closes today once every time is inside the lead time", () => {
    const evening = new Date("2026-11-05T16:30:00Z"); // 18:30 in Harare
    const [today, tomorrow] = dates({ now: evening });
    expect(today.open).toBe(false);
    expect(tomorrow.open).toBe(true);
  });

  it("counts a long lead time day by day, past tomorrow", () => {
    const threeDays = { ...rules, minLeadMinutes: 3 * 24 * 60 };
    expect(dates({ rules: threeDays }).slice(0, 4).map((day) => day.open)).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });
});

describe("sitting length", () => {
  it("is the large party's from large_party_size up", () => {
    expect(sittingFor(rules, 4)).toBe(90);
    expect(sittingFor(rules, 5)).toBe(120);
  });

  it("gives a hold of the sitting plus the buffer", () => {
    const startsAt = new Date("2026-11-06T16:00:00Z");
    expect(holdFor(rules, 2, startsAt)).toEqual({
      startsAt,
      endsAt: new Date("2026-11-06T17:30:00Z"),
      holdEndsAt: new Date("2026-11-06T17:45:00Z"),
    });
    expect(holdFor(rules, 5, startsAt).holdEndsAt).toEqual(new Date("2026-11-06T18:15:00Z"));
  });
});

describe("which tables", () => {
  it("are best fit: capacity first, then the owner's order", () => {
    const tables = [
      table("big", 8),
      table("second", 4, { sortOrder: 2 }),
      table("first", 4, { sortOrder: 1 }),
      table("small", 2),
    ];
    expect(tablesFor(tables, 3).map((t) => t.id)).toEqual(["first", "second", "big"]);
  });

  it("leave out walk-in tables and archived ones, and any too small", () => {
    const tables = [
      table("walk-ins", 4, { bookable: false }),
      table("archived", 4, { archivedAt: new Date() }),
      table("small", 2),
      table("good", 3),
    ];
    expect(tablesFor(tables, 3).map((t) => t.id)).toEqual(["good"]);
  });

  it("fit a party exactly: capacity equal to the party is enough", () => {
    expect(tablesFor([table("exact", 4)], 4).map((t) => t.id)).toEqual(["exact"]);
  });
});

describe("what's available", () => {
  const dinner = everyDay("Dinner", "18:00", "20:00");
  // A booking 18:00-19:30 in Harare, held to 19:45.
  const booked = hold("2026-11-06T16:00:00Z", "2026-11-06T17:45:00Z");

  it("hides a time whose hold would overlap a booking, and shows the first that clears it", () => {
    expect(shown({ periods: dinner, holds: [booked] })).toEqual(["20:00"]);
  });

  it("treats a hold as half-open, like the constraint: ending as another starts is fine", () => {
    const endsAtEight = hold("2026-11-06T16:00:00Z", "2026-11-06T18:00:00Z");
    expect(shown({ periods: dinner, holds: [endsAtEight] })).toEqual(["20:00"]);

    const startsAtEight = hold("2026-11-06T18:00:00Z", "2026-11-06T20:00:00Z");
    // 18:00's hold ends at 19:45; 18:30's at 20:15, which reaches the booking.
    expect(shown({ periods: dinner, holds: [startsAtEight] })).toEqual(["18:00"]);
  });

  it("counts the buffer: a hold is longer than the sitting", () => {
    const fromEight = hold("2026-11-06T18:00:00Z", "2026-11-06T20:00:00Z");
    const noBuffer = { ...rules, bufferMinutes: 0 };
    expect(shown({ periods: dinner, holds: [fromEight], rules: noBuffer })).toEqual([
      "18:00",
      "18:30",
    ]);
  });

  it("uses the longer sitting for a large party", () => {
    const fromEight = hold("2026-11-06T18:00:00Z", "2026-11-06T20:00:00Z");
    const tables = [table("t1", 6)];
    expect(shown({ periods: dinner, holds: [fromEight], tables, party: 4 })).toEqual(["18:00"]);
    expect(shown({ periods: dinner, holds: [fromEight], tables, party: 5 })).toEqual([]);
  });

  it.each(["confirmed", "seated", "completed"])("is blocked by a %s booking, as the constraint is", (status) => {
    expect(shown({ periods: dinner, holds: [{ ...booked, status }] })).toEqual(["20:00"]);
  });

  it.each(["cancelled", "no_show"])("isn't blocked by a %s booking", (status) => {
    expect(shown({ periods: dinner, holds: [{ ...booked, status }] })).toEqual([
      "18:00",
      "18:30",
      "19:00",
      "19:30",
      "20:00",
    ]);
  });

  it("only counts a booking on that table", () => {
    const elsewhere = { ...booked, tableId: "t2" };
    expect(shown({ periods: dinner, holds: [elsewhere] })).toHaveLength(5);
  });

  it("lists the free tables best fit first, skipping the one that's held", () => {
    const tables = [table("t3", 8), table("t1", 2), table("t2", 4)];
    const [first] = availableTimes({ ...input, periods: dinner, tables, holds: [booked] });
    expect(first.time).toBe("18:00");
    expect(first.tableIds).toEqual(["t2", "t3"]);
  });

  it("has nothing for a party no bookable table fits", () => {
    expect(shown({ party: 3 })).toEqual([]);
  });

  it("has nothing while booking is off", () => {
    expect(shown({ rules: { ...rules, enabled: false } })).toEqual([]);
  });

  it.each([0, -1, 9])("has nothing for a party of %i", (party) => {
    expect(shown({ party, tables: [table("t1", 20)] })).toEqual([]);
  });
});

describe("nearest times", () => {
  const dinner = availableTimes({ ...input, periods: everyDay("Dinner", "18:00", "21:00") });
  const wanted = instantOf(date, "19:30", HARARE);

  it("gives the closest, in the order a day reads", () => {
    expect(nearestTimes(dinner, wanted, 3).map((slot) => slot.time)).toEqual([
      "19:00",
      "19:30",
      "20:00",
    ]);
  });

  it("prefers the earlier of two equally close times", () => {
    const without = dinner.filter((slot) => slot.time !== "19:30");
    expect(nearestTimes(without, wanted, 1).map((slot) => slot.time)).toEqual(["19:00"]);
  });

  it("is empty when nothing is left", () => {
    expect(nearestTimes([], wanted)).toEqual([]);
  });
});
