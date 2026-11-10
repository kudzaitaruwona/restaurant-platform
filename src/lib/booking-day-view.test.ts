import { describe, expect, it } from "vitest";
import {
  chooseDay,
  contactLinks,
  DAY_WINDOW_DAYS,
  type DayRow,
  groupByPeriod,
} from "./booking-day-view";

const today = "2026-11-05";

describe("chooseDay", () => {
  it("defaults to today", () => {
    expect(chooseDay(undefined, today)).toEqual({ date: today, refused: false });
    expect(chooseDay("", today)).toEqual({ date: today, refused: false });
  });

  it("takes a real date inside the window", () => {
    expect(chooseDay("2026-12-25", today)).toEqual({ date: "2026-12-25", refused: false });
    expect(chooseDay("2026-01-02", today)).toEqual({ date: "2026-01-02", refused: false });
  });

  it("takes the window's two edges and refuses the day past each", () => {
    expect(chooseDay("2027-11-06", today).refused).toBe(false);
    expect(chooseDay("2027-11-07", today).refused).toBe(true);
    expect(chooseDay("2025-11-04", today).refused).toBe(false);
    expect(chooseDay("2025-11-03", today).refused).toBe(true);
    expect(DAY_WINDOW_DAYS).toBe(366);
  });

  it.each([
    "2026-02-31",
    "2026-13-01",
    "9999-12-31",
    "0000-01-01",
    "+275760-09-13",
    "2026-11-05T00:00",
    "tomorrow",
    "2026-11-05\0",
    "x".repeat(10_000),
    "NaN",
    "' or 1=1 --",
    "２０２６-11-05",
  ])("shows today, flagged, for %j", (value) => {
    expect(chooseDay(value, today)).toEqual({ date: today, refused: true });
  });

  it("takes the first of a repeated parameter", () => {
    expect(chooseDay(["2026-12-01", "junk"], today).date).toBe("2026-12-01");
    expect(chooseDay(["junk", "2026-12-01"], today)).toEqual({ date: today, refused: true });
    expect(chooseDay([], today)).toEqual({ date: today, refused: false });
  });
});

const row = (time: string, overrides: Partial<DayRow> = {}): DayRow => ({
  id: crypto.randomUUID(),
  time,
  guestName: "Guest",
  partySize: 2,
  table: "T1",
  status: "confirmed",
  note: null,
  phone: null,
  late: false,
  confirmationFailed: false,
  ...overrides,
});

const lunch = { name: "Lunch", opensAt: "12:00:00", closesAt: "15:00:00" };
const dinner = { name: "Dinner", opensAt: "18:00:00", closesAt: "23:00:00" };

describe("groupByPeriod", () => {
  it("puts a booking in its period, in period order whatever order they come", () => {
    const groups = groupByPeriod(
      [dinner, lunch],
      [row("12:00"), row("18:30", { partySize: 4 }), row("14:59")],
    );
    expect(groups.map((g) => [g.name, g.bookingCount, g.covers])).toEqual([
      ["Lunch", 2, 4],
      ["Dinner", 1, 4],
    ]);
  });

  it("treats a period as [opens, closes): a booking at the closing minute is Other", () => {
    const groups = groupByPeriod([lunch], [row("15:00"), row("11:59"), row("12:00")]);
    expect(groups.map((g) => [g.name, g.rows.map((r) => r.time)])).toEqual([
      ["Lunch", ["12:00"]],
      ["Other", ["15:00", "11:59"]],
    ]);
  });

  it("puts a booking just after midnight, and at 23:59, in Other when no period reaches them", () => {
    const groups = groupByPeriod([dinner], [row("00:00"), row("23:59")]);
    expect(groups.at(-1)).toMatchObject({ name: "Other", bookingCount: 2 });
    expect(groups[0].rows).toEqual([]);
  });

  it("keeps an empty period, and leaves Other out when it holds nothing", () => {
    expect(groupByPeriod([lunch, dinner], [])).toEqual([
      { name: "Lunch", bookingCount: 0, covers: 0, rows: [] },
      { name: "Dinner", bookingCount: 0, covers: 0, rows: [] },
    ]);
  });

  it("shows only Other when the day has no periods", () => {
    expect(groupByPeriod([], [row("19:00")]).map((g) => g.name)).toEqual(["Other"]);
  });

  it("lists cancelled and no-show bookings but doesn't count them", () => {
    const [group] = groupByPeriod(
      [dinner],
      [
        row("18:00", { status: "cancelled", partySize: 6 }),
        row("18:30", { status: "no_show", partySize: 3 }),
        row("19:00", { status: "seated", partySize: 2 }),
        row("19:30", { status: "completed", partySize: 5 }),
        row("20:00", { status: "confirmed", partySize: 1 }),
      ],
    );
    expect(group.rows).toHaveLength(5);
    expect([group.bookingCount, group.covers]).toEqual([3, 8]);
  });
});

describe("contactLinks", () => {
  it("builds tel: and wa.me from the stored E.164 number", () => {
    expect(contactLinks("+263771234567")).toEqual({
      tel: "tel:+263771234567",
      whatsapp: "https://wa.me/263771234567",
    });
  });

  it.each([null, "", "0771234567", "+0771234567", "+26377", "+263 771 234 567", "+263771234567/../x", "javascript:alert(1)"])(
    "gives no link for %j",
    (phone) => {
      expect(contactLinks(phone)).toBeUndefined();
    },
  );
});
