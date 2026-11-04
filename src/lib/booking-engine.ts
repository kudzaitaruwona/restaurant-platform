/**
 * The availability engine (spec 04): what can be seated, and at which table. Pure
 * and given the moment it runs, so one set of inputs always gives one answer: the
 * list a guest sees and the confirm that follows both come through availableTimes.
 *
 * Every date and time a guest chooses is the restaurant's wall clock, and every
 * comparison is between instants. Nothing here may read the process's timezone:
 * a local date is a "YYYY-MM-DD" string, and `Date` holds instants only. Date.UTC
 * and getUTCDay below do calendar arithmetic on those strings; they aren't "the
 * time in UTC".
 *
 * This says what the list should show. Postgres's bookings_no_overlap is what
 * actually prevents a double booking, and closures are the same: a sitting that
 * runs into one is dropped here, and bookings_within_closure (migration 0026) is
 * what refuses it.
 */

/** "YYYY-MM-DD" on the restaurant's calendar. */
export type LocalDate = string;

export type Rules = {
  enabled: boolean;
  slotIntervalMinutes: number;
  sittingMinutes: number;
  largePartySize: number;
  largePartySittingMinutes: number;
  bufferMinutes: number;
  minLeadMinutes: number;
  maxDaysAhead: number;
  maxOnlinePartySize: number;
};

export type Period = {
  name: string;
  weekday: number;
  /** Postgres `time`: "HH:MM:SS" or "HH:MM". */
  opensAt: string;
  lastBookingAt: string;
};

/**
 * A time the restaurant is shut (spec 04): half-open like everything here, so a
 * sitting that ends at the instant a closure starts is not in it. A date-only
 * closure is already local midnight to the next local midnight when it gets here.
 */
export type Closure = {
  startsAt: Date;
  endsAt: Date;
};

export type EngineTable = {
  id: string;
  capacity: number;
  bookable: boolean;
  sortOrder: number;
  archivedAt: Date | null;
};

export type Hold = {
  /** Set when a caller needs to leave one booking out of the count (a move). */
  id?: string;
  tableId: string;
  startsAt: Date;
  holdEndsAt: Date;
  status: string;
};

export type Candidate = {
  period: string;
  /** "HH:MM" on the restaurant's wall clock. */
  time: string;
  startsAt: Date;
};

export type AvailableTime = Candidate & {
  /** The tables that could take the party, best fit first. Never shown to a guest. */
  tableIds: string[];
};

/** Must match the WHERE of bookings_no_overlap, or the list offers what confirm can't seat. */
export const blockingStatuses = ["confirmed", "seated", "completed"] as const;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const calendarDay = (date: LocalDate) => Date.parse(`${date}T00:00:00Z`);

/** True only for a date that exists: 2026-02-31 doesn't. */
export const isLocalDate = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(calendarDay(value)) &&
  new Date(calendarDay(value)).toISOString().startsWith(value);

export const addDays = (date: LocalDate, days: number): LocalDate =>
  new Date(calendarDay(date) + days * DAY).toISOString().slice(0, 10);

/** 0 = Sunday, as service_periods.weekday. */
export const weekdayOf = (date: LocalDate) => new Date(calendarDay(date)).getUTCDay();

/** "Thu 5 Nov". The zone here only reads the calendar date back out. */
export const dateLabel = (date: LocalDate) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(calendarDay(date));

// Building a formatter costs far more than using one, and a day has many slots.
const clocks = new Map<string, Intl.DateTimeFormat>();

function clockIn(timezone: string) {
  let clock = clocks.get(timezone);
  if (!clock) {
    clock = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    clocks.set(timezone, clock);
  }
  return clock;
}

/** What the restaurant's clock and calendar say at an instant. */
function wallClock(instant: Date, timezone: string) {
  const parts = Object.fromEntries(
    clockIn(timezone)
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    second: Number(parts.second),
  };
}

export const localToday = (now: Date, timezone: string): LocalDate =>
  wallClock(now, timezone).date;

/** "HH:MM" on the restaurant's clock, for showing an instant. */
export const localTime = (instant: Date, timezone: string) =>
  wallClock(instant, timezone).time;

const minutesOf = (time: string) => {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
};

const clockOf = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** How far the zone's clock is ahead of UTC at an instant, in milliseconds. */
function offsetAt(instant: number, timezone: string) {
  const { date, time, second } = wallClock(new Date(instant), timezone);
  const asIfUtc = calendarDay(date) + minutesOf(time) * MINUTE + second * 1000;
  return asIfUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant a wall clock in `timezone` reads `date` and `time`: Postgres's
 * `(d + t) AT TIME ZONE tz`. Twice, because the offset that matters is the one at
 * the answer, not at the first guess. Only in the hour a clock changes can it
 * differ from Postgres, and then it is still a real instant near that time.
 */
export function instantOf(date: LocalDate, time: string, timezone: string) {
  const naive = calendarDay(date) + minutesOf(time) * MINUTE;
  const guess = naive - offsetAt(naive, timezone);
  return new Date(naive - offsetAt(guess, timezone));
}

/** How long a party keeps its table, before the reset buffer. */
export const sittingFor = (rules: Rules, party: number) =>
  party >= rules.largePartySize ? rules.largePartySittingMinutes : rules.sittingMinutes;

/** The whole time a booking starting at `startsAt` takes a table out of use. */
export function holdFor(rules: Rules, party: number, startsAt: Date) {
  const endsAt = new Date(startsAt.getTime() + sittingFor(rules, party) * MINUTE);
  return {
    startsAt,
    endsAt,
    holdEndsAt: new Date(endsAt.getTime() + rules.bufferMinutes * MINUTE),
  };
}

/**
 * Whether a sitting from `startsAt` for `sittingMinutes` runs into a closure,
 * ignoring the reset buffer *(proposed)*: the engine's "[t, t + sitting) overlaps
 * any closure", and the same range bookings_within_closure judges (starts_at to
 * ends_at). Touching isn't overlapping.
 */
export function runsIntoClosure(
  closures: readonly Closure[],
  startsAt: Date,
  sittingMinutes: number,
) {
  const endsAt = startsAt.getTime() + sittingMinutes * MINUTE;
  return closures.some(
    (closure) => closure.startsAt.getTime() < endsAt && startsAt.getTime() < closure.endsAt.getTime(),
  );
}

/**
 * Every time a party could start on `date`, ignoring the tables: the grid of each
 * of that weekday's periods, less whatever is inside the lead time and whatever
 * runs into a closure for `sittingMinutes`. Dates outside the window have none.
 */
export function candidateTimes(input: {
  date: LocalDate;
  rules: Rules;
  periods: readonly Period[];
  closures: readonly Closure[];
  /** The party's sitting: a party's list and its confirm both pass `sittingFor`. */
  sittingMinutes: number;
  timezone: string;
  now: Date;
}): Candidate[] {
  const { date, rules, periods, closures, sittingMinutes, timezone, now } = input;
  const today = localToday(now, timezone);
  if (date < today || date > addDays(today, rules.maxDaysAhead)) return [];

  const earliest = now.getTime() + rules.minLeadMinutes * MINUTE;
  const weekday = weekdayOf(date);
  return periods
    .filter((period) => period.weekday === weekday)
    .toSorted((a, b) => minutesOf(a.opensAt) - minutesOf(b.opensAt))
    .flatMap((period) => {
      const times: Candidate[] = [];
      const last = minutesOf(period.lastBookingAt);
      for (let at = minutesOf(period.opensAt); at <= last; at += rules.slotIntervalMinutes) {
        const time = clockOf(at);
        const startsAt = instantOf(date, time, timezone);
        if (startsAt.getTime() >= earliest && !runsIntoClosure(closures, startsAt, sittingMinutes)) {
          times.push({ period: period.name, time, startsAt });
        }
      }
      return times;
    });
}

/**
 * Every local date a guest may pick, today first, and whether it has any time to
 * offer. Whether tables are free doesn't come into it: a full date stays open and
 * shows no times. Past the lead time a period on the weekday is all it takes, so
 * a year ahead doesn't mean working out a year of slots: only a date that a
 * closure touches is worked out in full, because a closure can leave it nothing
 * (a partly closed date stays open with fewer times). The sitting is the party's
 * when it is known, and otherwise the shorter of the two, so no date is greyed
 * out for a sitting that would have fit.
 */
export function bookableDates(input: {
  rules: Rules;
  periods: readonly Period[];
  closures: readonly Closure[];
  /** The party the page has so far, if any. */
  party?: number;
  timezone: string;
  now: Date;
}) {
  const { rules, periods, closures, party, timezone, now } = input;
  const sittingMinutes =
    party === undefined
      ? Math.min(rules.sittingMinutes, rules.largePartySittingMinutes)
      : sittingFor(rules, party);
  const today = localToday(now, timezone);
  const leadTimeEnds = localToday(
    new Date(now.getTime() + rules.minLeadMinutes * MINUTE + DAY),
    timezone,
  );
  return Array.from({ length: rules.maxDaysAhead + 1 }, (_, days) => {
    const date = addDays(today, days);
    const touched = closures.some(
      (closure) =>
        closure.startsAt < instantOf(addDays(date, 1), "00:00", timezone) &&
        instantOf(date, "00:00", timezone) < closure.endsAt,
    );
    const open =
      date > leadTimeEnds && !touched
        ? periods.some((period) => period.weekday === weekdayOf(date))
        : candidateTimes({ date, rules, periods, closures, sittingMinutes, timezone, now }).length > 0;
    return { date, open };
  });
}

/** Bookable, not archived, big enough: smallest first, then the owner's order. */
export const tablesFor = (tables: readonly EngineTable[], party: number) =>
  tables
    .filter((table) => table.bookable && table.archivedAt === null && table.capacity >= party)
    .toSorted(
      (a, b) =>
        a.capacity - b.capacity ||
        a.sortOrder - b.sortOrder ||
        a.id.localeCompare(b.id),
    );

/** Half-open, like the tstzrange in bookings_no_overlap: touching doesn't overlap. */
const overlaps = (hold: Hold, startsAt: Date, holdEndsAt: Date) =>
  hold.startsAt < holdEndsAt && startsAt < hold.holdEndsAt;

const blocks = (hold: Hold) => (blockingStatuses as readonly string[]).includes(hold.status);

/**
 * The times a party can actually be seated on `date`, with the tables that could
 * take it. Both the guest's list and confirm come from here, so they can't
 * disagree. `holds` are the day's bookings, by any status: this decides which
 * count, so no caller can pick another set.
 */
export function availableTimes(input: {
  party: number;
  date: LocalDate;
  rules: Rules;
  periods: readonly Period[];
  closures: readonly Closure[];
  tables: readonly EngineTable[];
  holds: readonly Hold[];
  timezone: string;
  now: Date;
}): AvailableTime[] {
  const { party, rules, tables, holds } = input;
  if (!rules.enabled || party < 1 || party > rules.maxOnlinePartySize) return [];

  const fitting = tablesFor(tables, party);
  const live = holds.filter(blocks);
  return candidateTimes({ ...input, sittingMinutes: sittingFor(rules, party) }).flatMap((candidate) => {
    const { holdEndsAt } = holdFor(rules, party, candidate.startsAt);
    const tableIds = fitting
      .filter(
        (table) =>
          !live.some(
            (hold) =>
              hold.tableId === table.id && overlaps(hold, candidate.startsAt, holdEndsAt),
          ),
      )
      .map((table) => table.id);
    return tableIds.length > 0 ? [{ ...candidate, tableIds }] : [];
  });
}

/**
 * The rules as staff book under them (spec 04, Add booking): the engine is the
 * same, and these are the overrides, each explicit. Inside the lead time (a time
 * from now on still can't be in the past), over max_online_party_size (the table
 * still has to seat the party), and with online booking switched off, because the
 * switch is for guests *(proposed)*. Only the staff routes call this: no request
 * field reaches it, and the guest's routes never import it.
 */
export const staffRules = (rules: Rules): Rules => ({
  ...rules,
  enabled: true,
  minLeadMinutes: 0,
  maxOnlinePartySize: Number.POSITIVE_INFINITY,
});

/**
 * Tables that could take a hold of `window` from another booking, in the order a
 * list reads: live, big enough when a party is given, and no confirmed, seated or completed hold
 * overlapping the window, bar the booking being moved. Whether a table is
 * walk-ins only is the caller's to say: staff may use one.
 */
export function freeTables(
  tables: readonly EngineTable[],
  holds: readonly Hold[],
  window: { startsAt: Date; holdEndsAt: Date; party?: number; ignore?: string },
) {
  const live = holds.filter((hold) => blocks(hold) && (window.ignore === undefined || hold.id !== window.ignore));
  return tables
    .filter(
      (table) =>
        table.archivedAt === null &&
        (window.party === undefined || table.capacity >= window.party) &&
        !live.some(
          (hold) => hold.tableId === table.id && overlaps(hold, window.startsAt, window.holdEndsAt),
        ),
    )
    .toSorted((a, b) => a.sortOrder - b.sortOrder || a.capacity - b.capacity || a.id.localeCompare(b.id));
}

/** The closest times to the one a guest wanted, in the order a day reads. */
export function nearestTimes(times: readonly AvailableTime[], wanted: Date, count = 4) {
  const distance = (time: AvailableTime) => Math.abs(time.startsAt.getTime() - wanted.getTime());
  return times
    .toSorted((a, b) => distance(a) - distance(b) || a.startsAt.getTime() - b.startsAt.getTime())
    .slice(0, count)
    .toSorted((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}
