import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auditLog, bookings, closures, diningTables } from "@/db/schema";
import { addDays, instantOf, localToday } from "@/lib/booking-engine";
import { aBooking, bookableRestaurant, bookingsOf } from "../../test/integration/bookings";
import { openOwnerDatabase, testDatabaseSettings } from "../../test/integration/database";
import {
  addClosure,
  type ClosureRequest,
  closureLabel,
  deleteClosure,
  listClosures,
  parseClosure,
} from "./booking-closures";
import { addStaffBooking, getStaffBookingForm, type StaffRequest } from "./booking-staff";
import { confirmBooking, getBookingPage, type GuestRequest } from "./bookings";
import { seatWalkIn } from "./walk-in";

/**
 * Closures (#38) against real rows, as app_tenant, each test on a restaurant of its
 * own. The guards themselves are tested at Postgres in src/db/closures.int.test.ts;
 * these are the app on top of them: what the owner is told, and that the guest's
 * list, the guest's confirm and the staff's add all agree about a closed time.
 */
const owner = openOwnerDatabase();

beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});
afterAll(async () => {
  await owner.pool.end();
  vi.unstubAllEnvs();
});

const HARARE = "Africa/Harare";
// The clock is the real one (the guards judge against Postgres's now()), and
// every date below is worked out from it, on the restaurant's calendar.
const now = new Date();
const today = localToday(now, HARARE);
const day = (inDays: number) => addDays(today, inDays);
/** The closing date a test uses: well clear of the lead time, within days ahead. */
const date = day(3);

const actor = (restaurantId: string, extra: { platformAdminId?: string } = {}) => ({
  restaurantId,
  staffId: crypto.randomUUID(),
  ...extra,
});

const form = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return body;
};

const parsed = (fields: Record<string, string>): ClosureRequest => {
  const result = parseClosure(form(fields));
  if (!result.success) throw new Error(result.message);
  return result.data;
};

const closuresOf = (restaurantId: string) =>
  owner.db.select().from(closures).where(eq(closures.restaurantId, restaurantId));

const guest = (overrides: Partial<GuestRequest> = {}): GuestRequest => ({
  party: 2,
  date,
  time: "19:00",
  name: "Tariro",
  phone: "+263771234567",
  note: null,
  whatsappOptIn: true,
  ...overrides,
});

const staffRequest = (overrides: Partial<StaffRequest> = {}): StaffRequest => ({
  party: 2,
  date,
  time: "19:00",
  tableId: undefined,
  name: "Staff guest",
  phone: null,
  note: null,
  whatsappOptIn: false,
  ...overrides,
});

/** The times the guest's page lists for the date: none when the date is disabled, which it says too. */
const timesOn = async (restaurantId: string, party = 2, onDate = date) =>
  (await getBookingPage({ restaurantId }, { party: String(party), date: onDate }, now)).times?.map(
    ({ time }) => time,
  ) ?? [];

/** Saves the closure 19:00 to 22:00 on `date`, as the owner would. */
const closeEvening = (restaurantId: string) =>
  addClosure(actor(restaurantId), parsed({ startDate: date, startTime: "19:00", endTime: "22:00" }), now);

describe("what a form can say", () => {
  it("is a start date alone, which is that whole date", () => {
    expect(parsed({ startDate: "2026-12-25" })).toEqual({
      startDate: "2026-12-25",
      endDate: "2026-12-25",
      times: undefined,
      reason: null,
    });
  });

  it("is a range of dates, with a reason, trimmed", () => {
    expect(parsed({ startDate: "2026-12-24", endDate: "2026-12-26", reason: "  Christmas  " })).toMatchObject({
      endDate: "2026-12-26",
      reason: "Christmas",
    });
  });

  it("is a range of times on the restaurant's clock", () => {
    expect(parsed({ startDate: "2026-12-25", startTime: "19:00", endTime: "22:00" }).times).toEqual({
      start: "19:00",
      end: "22:00",
    });
  });

  it.each([
    ["no start date", {}],
    ["a start date that isn't one", { startDate: "2026-02-31" }],
    ["a start date in another shape", { startDate: "25/12/2026" }],
    ["an end date that isn't one", { startDate: "2026-12-25", endDate: "tomorrow" }],
    ["an end date before the start", { startDate: "2026-12-25", endDate: "2026-12-24" }],
    ["one time and not the other", { startDate: "2026-12-25", startTime: "19:00" }],
    ["a time that isn't one", { startDate: "2026-12-25", startTime: "25:00", endTime: "26:00" }],
    ["an end time before the start on one date", { startDate: "2026-12-25", startTime: "22:00", endTime: "19:00" }],
    ["the same start and end time on one date", { startDate: "2026-12-25", startTime: "19:00", endTime: "19:00" }],
    ["a reason over 200 characters", { startDate: "2026-12-25", reason: "x".repeat(201) }],
    ["a NUL in the reason", { startDate: "2026-12-25", reason: "a\0b" }],
  ])("refuses %s, with a sentence", (_label, fields) => {
    const result = parseClosure(form(fields));

    expect(result.success).toBe(false);
    expect(result.success ? "" : result.message).toMatch(/\w/);
  });

  it("allows an end time before the start time when the dates differ: an overnight closure", () => {
    expect(
      parsed({ startDate: "2026-12-25", endDate: "2026-12-26", startTime: "22:00", endTime: "06:00" }),
    ).toMatchObject({ times: { start: "22:00", end: "06:00" } });
  });
});

describe("saving a closure", () => {
  it("stores a date-only closure from local midnight to the next local midnight in Harare", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db);

    const result = await addClosure(actor(restaurantId), parsed({ startDate: date, reason: "Holiday" }), now);

    expect(result).toMatchObject({ outcome: "saved" });
    const [row] = await closuresOf(restaurantId);
    // Harare is UTC+2 all year: local midnight is 22:00 UTC the evening before.
    expect(row.startsAt).toEqual(new Date(`${addDays(date, -1)}T22:00:00Z`));
    expect(row.endsAt).toEqual(new Date(`${date}T22:00:00Z`));
    expect(row.reason).toBe("Holiday");
  });

  it("stores a run of dates through the midnight after the last", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db);

    await addClosure(actor(restaurantId), parsed({ startDate: date, endDate: day(5) }), now);

    const [row] = await closuresOf(restaurantId);
    expect(row.startsAt).toEqual(new Date(`${addDays(date, -1)}T22:00:00Z`));
    expect(row.endsAt).toEqual(new Date(`${day(5)}T22:00:00Z`));
  });

  it("stores a datetime range on the restaurant's clock, also across midnight", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db);

    await closeEvening(restaurantId);
    await addClosure(
      actor(restaurantId),
      parsed({ startDate: day(6), endDate: day(7), startTime: "22:00", endTime: "06:00" }),
      now,
    );

    const rows = (await closuresOf(restaurantId)).toSorted((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    expect(rows[0].startsAt).toEqual(new Date(`${date}T17:00:00Z`));
    expect(rows[0].endsAt).toEqual(new Date(`${date}T20:00:00Z`));
    expect(rows[1].startsAt).toEqual(new Date(`${day(6)}T20:00:00Z`));
    expect(rows[1].endsAt).toEqual(new Date(`${day(7)}T04:00:00Z`));
  });

  // A date-only closure is as long as the local day: 23 or 25 hours on a clock change.
  // The restaurant's zone does the work, so the server's own zone can't be what it uses.
  describe.each([
    ["London, clocks forward (23 hours)", "Europe/London", "2027-03-28", "2027-03-28T00:00:00Z", "2027-03-28T23:00:00Z"],
    ["London, clocks back (25 hours)", "Europe/London", "2027-10-31", "2027-10-30T23:00:00Z", "2027-11-01T00:00:00Z"],
    ["New York, clocks forward (23 hours)", "America/New_York", "2027-03-14", "2027-03-14T05:00:00Z", "2027-03-15T04:00:00Z"],
    ["New York, clocks back (25 hours)", "America/New_York", "2027-11-07", "2027-11-07T04:00:00Z", "2027-11-08T05:00:00Z"],
    ["Harare (always 24)", "Africa/Harare", "2027-03-28", "2027-03-27T22:00:00Z", "2027-03-28T22:00:00Z"],
  ])("a date-only closure in %s", (_label, timezone, closed, startsAt, endsAt) => {
    it("runs from that date's local midnight to the next local midnight, as Postgres has it", async () => {
      const { restaurantId } = await bookableRestaurant(owner.db, { timezone });

      const result = await addClosure(
        actor(restaurantId),
        parsed({ startDate: closed }),
        new Date("2027-02-01T00:00:00Z"),
      );

      expect(result).toMatchObject({ outcome: "saved" });
      const [row] = await closuresOf(restaurantId);
      expect(row.startsAt).toEqual(new Date(startsAt));
      expect(row.endsAt).toEqual(new Date(endsAt));
    });

    it("is the same instants the availability engine finds for the date's edges", () => {
      expect(instantOf(closed, "00:00", timezone)).toEqual(new Date(startsAt));
      expect(instantOf(addDays(closed, 1), "00:00", timezone)).toEqual(new Date(endsAt));
    });
  });

  it("refuses what no closure can be, without throwing, and saves nothing", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db);
    const refusals: [string, Record<string, string>][] = [
      ["a date before today", { startDate: day(-1) }],
      ["year 0000", { startDate: "0000-01-01" }],
      ["a date far past the limit", { startDate: day(3), endDate: "9999-12-31" }],
      ["the last date there is", { startDate: "9999-12-31" }],
      ["more than 366 days", { startDate: day(1), endDate: day(1 + 367) }],
      ["a range that has already ended", { startDate: today, startTime: "00:00", endTime: "00:01" }],
    ];

    for (const [label, fields] of refusals) {
      const result = await addClosure(actor(restaurantId), parsed(fields), new Date());
      expect(result, label).toMatchObject({ outcome: "invalid" });
    }

    expect(await closuresOf(restaurantId)).toEqual([]);
  });

  it("allows a closure beginning earlier today and running on: a private event under way", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db);

    const result = await addClosure(
      actor(restaurantId),
      parsed({ startDate: today, endDate: day(1), startTime: "00:00", endTime: "23:59" }),
      now,
    );

    expect(result).toMatchObject({ outcome: "saved" });
  });

  it("audits a platform admin who saves or removes one, and nobody else", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db);
    const platformAdminId = crypto.randomUUID();
    const audit = () => owner.db.select().from(auditLog).where(eq(auditLog.restaurantId, restaurantId));

    await addClosure(actor(restaurantId), parsed({ startDate: day(2) }), now);
    expect(await audit()).toEqual([]);

    const added = await addClosure(actor(restaurantId, { platformAdminId }), parsed({ startDate: day(4) }), now);
    if (added.outcome !== "saved") throw new Error("not saved");
    await deleteClosure(actor(restaurantId, { platformAdminId }), added.id);

    const entries = await audit();
    expect(entries).toHaveLength(2);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actorType: "platform_admin", actorId: platformAdminId, action: "closure.create", entityId: added.id }),
        expect.objectContaining({ actorType: "platform_admin", actorId: platformAdminId, action: "closure.delete", entityId: added.id }),
      ]),
    );
  });
});

describe("saving over bookings", () => {
  const book = (restaurantId: string, tableId: string, extra: Partial<typeof bookings.$inferInsert> = {}) =>
    owner.db.insert(bookings).values({
      ...aBooking(restaurantId, tableId, `${date}T17:00:00Z`, `${date}T18:45:00Z`),
      endsAt: new Date(`${date}T18:30:00Z`),
      guestName: "Rudo Chikwanha",
      guestPhone: "+263772223333",
      ...extra,
    });

  it("lists the bookings in the way by name, time and party, never a phone, and saves nothing", async () => {
    const { restaurantId, tableIds: [one, two] } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 2 }, { capacity: 4 }],
    });
    await book(restaurantId, one);
    await book(restaurantId, two, {
      guestName: "Farai",
      partySize: 1,
      startsAt: new Date(`${date}T18:00:00Z`),
      endsAt: new Date(`${date}T19:30:00Z`),
      holdEndsAt: new Date(`${date}T19:45:00Z`),
    });

    const result = await closeEvening(restaurantId);

    expect(result).toMatchObject({
      outcome: "blocked",
      bookings: [
        { guestName: "Rudo Chikwanha", partySize: 2, summary: expect.stringContaining("19:00 · Rudo Chikwanha · 2 guests") },
        { guestName: "Farai", partySize: 1, summary: expect.stringContaining("20:00 · Farai · 1 guest") },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("+263772223333");
    expect(JSON.stringify(result)).not.toContain("manageToken");
    expect(await closuresOf(restaurantId)).toEqual([]);
  });

  it("saves once those bookings are cancelled or moved out of the time", async () => {
    const { restaurantId, tableIds: [one] } = await bookableRestaurant(owner.db);
    await book(restaurantId, one);
    expect(await closeEvening(restaurantId)).toMatchObject({ outcome: "blocked" });

    await owner.db.update(bookings).set({ status: "cancelled" }).where(eq(bookings.restaurantId, restaurantId));

    expect(await closeEvening(restaurantId)).toMatchObject({ outcome: "saved" });
  });

  it("is in the way only of a confirmed booking whose sitting runs into it: a seated one, a buffer, another restaurant's, don't count", async () => {
    const { restaurantId, tableIds: [seated, buffered] } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 2 }, { capacity: 2 }],
    });
    const other = await bookableRestaurant(owner.db);
    await book(restaurantId, seated, { status: "seated" });
    // The sitting ends at 19:00, as the closure starts; the hold runs 15 minutes into it.
    await book(restaurantId, buffered, {
      startsAt: new Date(`${date}T15:30:00Z`),
      endsAt: new Date(`${date}T17:00:00Z`),
      holdEndsAt: new Date(`${date}T17:15:00Z`),
    });
    await book(other.restaurantId, other.tableIds[0]);

    expect(await closeEvening(restaurantId)).toMatchObject({ outcome: "saved" });
  });

  it("answers a refusal by the database with the list as it stands, not an error", async () => {
    // The pre-read is skipped by making the list empty at read time and the guard decide:
    // a booking inserted by another connection after the owner's read is the real race, which
    // the file below runs against the real functions. Here, the answer when the guard refuses.
    const { restaurantId, tableIds: [one] } = await bookableRestaurant(owner.db);
    await book(restaurantId, one);

    const result = await closeEvening(restaurantId);

    expect(result).toMatchObject({ outcome: "blocked", bookings: [{ guestName: "Rudo Chikwanha" }] });
  });
});

describe("what a guest sees once a closure is saved", () => {
  it("drops the closed times and the sittings that run into them, from the list", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db, { tables: [{ capacity: 2 }, { capacity: 2 }] });
    // Dinner opens at 18:00, last booking 21:00, every 30 minutes: 7 times.
    expect(await timesOn(restaurantId)).toEqual(["18:00", "18:30", "19:00", "19:30", "20:00", "20:30", "21:00"]);

    await closeEvening(restaurantId);

    // 18:00 + 90 minutes runs into 19:00; nothing is left of the evening.
    expect(await timesOn(restaurantId)).toEqual([]);
  });

  it("keeps the times before a closure that their sittings clear", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db);
    await addClosure(actor(restaurantId), parsed({ startDate: date, startTime: "20:00", endTime: "23:00" }), now);

    // 18:30's sitting ends at 20:00 exactly, which is clear; 19:00's does not.
    expect(await timesOn(restaurantId)).toEqual(["18:00", "18:30"]);
  });

  it("uses the party's own sitting: a party of five loses the time a couple keeps", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db, { tables: [{ capacity: 6 }] });
    await addClosure(actor(restaurantId), parsed({ startDate: date, startTime: "20:00", endTime: "23:00" }), now);

    expect(await timesOn(restaurantId, 2)).toEqual(["18:00", "18:30"]);
    // 120 minutes: 18:30 + 120 = 20:30 runs into it.
    expect(await timesOn(restaurantId, 5)).toEqual(["18:00"]);
  });

  it("disables a date a closure leaves no times, and keeps a partly closed date with fewer", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db);
    await addClosure(actor(restaurantId), parsed({ startDate: date }), now);
    await addClosure(actor(restaurantId), parsed({ startDate: day(5), startTime: "20:00", endTime: "23:00" }), now);

    const page = await getBookingPage({ restaurantId }, { party: "2" }, now);
    const open = (inDays: number) => page.dates.find((candidate) => candidate.date === day(inDays))?.open;

    expect(open(3)).toBe(false);
    expect(open(2)).toBe(true);
    expect(open(4)).toBe(true);
    expect(open(5)).toBe(true);
    expect(await timesOn(restaurantId, 2, day(5))).toEqual(["18:00", "18:30"]);
  });

  it("refuses a confirm at a closed time with the race-lost answer, and offers the times that are left", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db);
    await addClosure(actor(restaurantId), parsed({ startDate: date, startTime: "20:00", endTime: "23:00" }), now);

    const result = await confirmBooking({ restaurantId }, guest({ time: "19:30" }), now);

    expect(result).toEqual({ outcome: "race_lost", times: [{ period: "Dinner", time: "18:00" }, { period: "Dinner", time: "18:30" }] });
    expect(await bookingsOf(owner.db, restaurantId)).toEqual([]);
  });

  it("the list and the confirm agree on every time of the day, with a closure part way through", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db);
    await addClosure(actor(restaurantId), parsed({ startDate: date, startTime: "19:45", endTime: "20:15" }), now);

    const listed = (await timesOn(restaurantId)) ?? [];
    expect(listed).toEqual(["18:00", "20:30", "21:00"]);
    // Every grid time: the ones listed confirm (on a table of its own), the rest don't.
    for (const time of ["18:00", "18:30", "19:00", "19:30", "20:00", "20:30", "21:00"]) {
      const fresh = await bookableRestaurant(owner.db);
      await addClosure(actor(fresh.restaurantId), parsed({ startDate: date, startTime: "19:45", endTime: "20:15" }), now);
      const outcome = await confirmBooking({ restaurantId: fresh.restaurantId }, guest({ time }), now);
      expect(outcome.outcome === "confirmed", time).toBe(listed.includes(time));
    }
  });

  it("the staff's add agrees with the guest's: staff keep to closures too", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db);
    await addClosure(actor(restaurantId), parsed({ startDate: date, startTime: "20:00", endTime: "23:00" }), now);

    expect(await addStaffBooking(actor(restaurantId), staffRequest({ time: "19:30" }), now)).toEqual({
      outcome: "time_unavailable",
    });
    expect(await addStaffBooking(actor(restaurantId), staffRequest({ time: "18:30" }), now)).toMatchObject({
      outcome: "added",
    });
    const form = await getStaffBookingForm({ restaurantId }, { party: "2", date }, now);
    expect(form.times?.map(({ time }) => time)).toEqual(["18:00", "18:30"]);
  });

  it("lets staff seat a walk-in inside a closure: whoever is at the door is seated", async () => {
    const { restaurantId, tableIds: [tableId] } = await bookableRestaurant(owner.db);
    await addClosure(
      actor(restaurantId),
      parsed({ startDate: today, endDate: day(1), startTime: "00:00", endTime: "23:59" }),
      now,
    );

    const result = await seatWalkIn(actor(restaurantId), tableId, 2);

    expect(result).toMatchObject({ outcome: "seated" });
  });

  it("offers the times again once the closure is removed", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db);
    await closeEvening(restaurantId);
    const [row] = await closuresOf(restaurantId);
    expect(await timesOn(restaurantId)).toEqual([]);

    expect(await deleteClosure(actor(restaurantId), row.id)).toBe("saved");

    expect(await timesOn(restaurantId)).toHaveLength(7);
    expect(await closuresOf(restaurantId)).toEqual([]);
  });
});

describe("a confirm and a closure save started together", () => {
  it.each(Array.from({ length: 12 }, (_, round) => round))(
    "round %i: never leaves a confirmed booking inside the closure, and neither call fails",
    async () => {
      const { restaurantId } = await bookableRestaurant(owner.db, { tables: [{ capacity: 2 }] });

      const [confirmation, saved] = await Promise.all([
        confirmBooking({ restaurantId }, guest({ time: "19:00" }), now),
        closeEvening(restaurantId),
      ]);

      const rows = await bookingsOf(owner.db, restaurantId);
      const saved_ = saved.outcome === "saved";
      expect(["saved", "blocked"]).toContain(saved.outcome);
      if (saved_) {
        expect(confirmation.outcome).not.toBe("confirmed");
        expect(rows).toEqual([]);
        expect(await closuresOf(restaurantId)).toHaveLength(1);
      } else {
        expect(confirmation.outcome).toBe("confirmed");
        expect(rows).toHaveLength(1);
        expect(await closuresOf(restaurantId)).toEqual([]);
      }
      const { rows: inside } = await owner.db.execute(sql`
        select 1 from bookings b join closures c on c.restaurant_id = b.restaurant_id
        where b.restaurant_id = ${restaurantId} and b.status = 'confirmed'
          and b.starts_at < c.ends_at and c.starts_at < b.ends_at
      `);
      expect(inside).toEqual([]);
    },
  );
});

describe("listing and removing", () => {
  it("lists closures that haven't ended, soonest first, on the restaurant's clock, and never a past one", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db);
    await owner.db.insert(closures).values({
      restaurantId,
      startsAt: new Date(now.getTime() - 5 * 86_400_000),
      endsAt: new Date(now.getTime() - 4 * 86_400_000),
      reason: "Long gone",
    });
    await addClosure(actor(restaurantId), parsed({ startDate: day(6), reason: "Later" }), now);
    await closeEvening(restaurantId);

    const rows = await listClosures({ restaurantId }, now);

    expect(rows.map(({ label, reason }) => [label, reason])).toEqual([
      [expect.stringMatching(/, 19:00 to 22:00$/), null],
      [expect.not.stringMatching(/:/), "Later"],
    ]);
  });

  it("reads whole dates as dates, a run as 'to', and part of a day with its times", () => {
    const at = (when: string) => instantOf(when.slice(0, 10), when.slice(11), HARARE);

    expect(closureLabel(at("2026-12-25T00:00"), at("2026-12-26T00:00"), HARARE)).toBe("Fri 25 Dec");
    expect(closureLabel(at("2026-12-25T00:00"), at("2026-12-28T00:00"), HARARE)).toBe("Fri 25 Dec to Sun 27 Dec");
    expect(closureLabel(at("2026-12-25T19:00"), at("2026-12-25T22:00"), HARARE)).toBe("Fri 25 Dec, 19:00 to 22:00");
    expect(closureLabel(at("2026-12-25T22:00"), at("2026-12-26T06:00"), HARARE)).toBe(
      "Fri 25 Dec, 22:00 to Sat 26 Dec, 06:00",
    );
  });

  it("removes only the restaurant's own closure: another's id is not found and untouched", async () => {
    const mine = await bookableRestaurant(owner.db);
    const theirs = await bookableRestaurant(owner.db);
    await closeEvening(theirs.restaurantId);
    const [theirClosure] = await closuresOf(theirs.restaurantId);

    expect(await deleteClosure(actor(mine.restaurantId), theirClosure.id)).toBe("not_found");
    expect(await deleteClosure(actor(mine.restaurantId), crypto.randomUUID())).toBe("not_found");

    expect(await closuresOf(theirs.restaurantId)).toHaveLength(1);
  });
});

describe("the tables a closure needs", () => {
  it("leaves tables alone: closing is not archiving", async () => {
    const { restaurantId, tableIds: [tableId] } = await bookableRestaurant(owner.db);
    await closeEvening(restaurantId);

    const [table] = await owner.db.select().from(diningTables).where(eq(diningTables.id, tableId));
    expect(table.archivedAt).toBeNull();
  });
});
