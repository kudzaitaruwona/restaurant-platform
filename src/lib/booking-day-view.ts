import { addDays, isLocalDate, type LocalDate } from "@/lib/booking-engine";

/**
 * The pure half of the staff day view (spec 04): which day a request means, how a
 * day's bookings fall into service periods, and the contact links. No database,
 * so it's tested on its own; src/lib/booking-day.ts reads the rows.
 */

/** How far either side of today the date picker goes *(proposed)*. */
export const DAY_WINDOW_DAYS = 366;

/** Statuses that hold or have held a table for a guest who came or is coming. */
export const countedStatuses = ["confirmed", "seated", "completed"] as const;

export type DayStatus = "confirmed" | "seated" | "completed" | "cancelled" | "no_show";

export type DayRow = {
  id: string;
  /** "HH:MM" on the restaurant's clock. */
  time: string;
  guestName: string;
  partySize: number;
  table: string;
  status: DayStatus;
  note: string | null;
  /** E.164, or null for a walk-in or once the retention job has run (D-06). */
  phone: string | null;
  /** Confirmed and not seated 30 minutes after its start: staff decide (spec 04). */
  late: boolean;
};

export type DayPeriod = { name: string; opensAt: string; closesAt: string };

export type DayGroup = {
  name: string;
  /** Not counted: cancelled and no-show bookings, which no one sits down for. */
  bookingCount: number;
  covers: number;
  rows: DayRow[];
};

export const OTHER_GROUP = "Other";

/**
 * The day a request names, or today. The query string is anyone's input: a value
 * that isn't a real date, or lies outside the window around today, shows today
 * and says so, never an error.
 */
export function chooseDay(raw: string | string[] | undefined, today: LocalDate) {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === "") return { date: today, refused: false };
  const earliest = addDays(today, -DAY_WINDOW_DAYS);
  const latest = addDays(today, DAY_WINDOW_DAYS);
  const usable = isLocalDate(value) && value >= earliest && value <= latest;
  return { date: usable ? value : today, refused: !usable };
}

const clock = (time: string) => time.slice(0, 5);

/**
 * Splits a day's bookings by the service period their start falls in, [opens, closes)
 * as the periods are, with what's left under "Other". Every period of the day is
 * there, empty or not; "Other" only when something is in it.
 */
export function groupByPeriod(periods: readonly DayPeriod[], rows: readonly DayRow[]): DayGroup[] {
  const ordered = periods.toSorted((a, b) => clock(a.opensAt).localeCompare(clock(b.opensAt)));
  const groups: DayGroup[] = ordered.map(({ name }) => ({
    name,
    bookingCount: 0,
    covers: 0,
    rows: [],
  }));
  const other: DayGroup = { name: OTHER_GROUP, bookingCount: 0, covers: 0, rows: [] };

  for (const row of rows) {
    const index = ordered.findIndex(
      (period) => row.time >= clock(period.opensAt) && row.time < clock(period.closesAt),
    );
    const group = index === -1 ? other : groups[index];
    group.rows.push(row);
    if ((countedStatuses as readonly string[]).includes(row.status)) {
      group.bookingCount += 1;
      group.covers += row.partySize;
    }
  }
  return other.rows.length > 0 ? [...groups, other] : groups;
}

/**
 * tel: and wa.me links from a stored number. Only a well-formed E.164 number gets
 * one, so nothing else can end up in an href.
 */
export function contactLinks(phone: string | null) {
  if (!phone || !/^[+][1-9][0-9]{7,14}$/.test(phone)) return undefined;
  return { tel: `tel:${phone}`, whatsapp: `https://wa.me/${phone.slice(1)}` };
}
