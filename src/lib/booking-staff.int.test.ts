import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auditLog, bookings, diningTables } from "@/db/schema";
import { aBooking, bookableRestaurant, bookingsOf } from "../../test/integration/bookings";
import { openOwnerDatabase, testDatabaseSettings } from "../../test/integration/database";
import { cancelBooking, seatBooking } from "./booking-day";
import {
  addStaffBooking,
  getMoveTargets,
  getStaffBookingForm,
  moveBooking,
  parseStaffRequest,
  type StaffRequest,
} from "./booking-staff";
import { confirmBooking, parseGuestRequest, type GuestRequest } from "./bookings";
import { seatWalkIn } from "./walk-in";

/**
 * Staff add a booking and move one (#36), against real rows as app_tenant, each
 * test on a restaurant of its own. Both go through the engine and Postgres, so
 * the tests ask the same questions of both and then the staff-only ones.
 */
const owner = openOwnerDatabase();

beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});
afterAll(async () => {
  await owner.pool.end();
  vi.unstubAllEnvs();
});

// 08:00 on Thursday 5 Nov in Harare (UTC+2, no daylight saving).
const now = new Date("2026-11-05T06:00:00Z");
const date = "2026-11-06"; // a Friday
/** 19:00 in Harare. Sitting 90 minutes and buffer 15 by default: held to 20:45. */
const SEVEN = "2026-11-06T17:00:00Z";
const QUARTER_TO_NINE = "2026-11-06T18:45:00Z";

const actor = (restaurantId: string, extra: { platformAdminId?: string } = {}) => ({
  restaurantId,
  staffId: crypto.randomUUID(),
  ...extra,
});

const request = (overrides: Partial<StaffRequest> = {}): StaffRequest => ({
  party: 2,
  date,
  time: "19:00",
  tableId: undefined,
  name: "Staff guest",
  phone: "+263771234567",
  note: null,
  whatsappOptIn: false,
  ...overrides,
});

const guest = (overrides: Partial<GuestRequest> = {}): GuestRequest => ({
  party: 2,
  date,
  time: "19:00",
  name: "Online guest",
  phone: "+263771234567",
  note: null,
  whatsappOptIn: true,
  ...overrides,
});

const rowOf = async (id: string) => (await owner.db.select().from(bookings).where(eq(bookings.id, id)))[0];
const auditOf = (restaurantId: string) =>
  owner.db.select().from(auditLog).where(eq(auditLog.restaurantId, restaurantId));

async function added(restaurantId: string, overrides: Partial<StaffRequest> = {}) {
  const result = await addStaffBooking(actor(restaurantId), request(overrides), now);
  if (result.outcome !== "added") throw new Error(`not added: ${result.outcome}`);
  return rowOf(result.id);
}

// --- adding -----------------------------------------------------------------

describe("add booking: the same engine", () => {
  it("books on the best-fit table at the restaurant's local time, as a confirmed staff booking", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 6, label: "Big" }, { capacity: 2, label: "Small" }],
    });

    const result = await addStaffBooking(actor(restaurantId), request({ note: "Window" }), now);

    expect(result).toMatchObject({ outcome: "added", time: "19:00", table: "Small" });
    const [row] = await bookingsOf(owner.db, restaurantId);
    expect(row).toMatchObject({
      tableId: tableIds[1],
      source: "staff",
      status: "confirmed",
      partySize: 2,
      guestName: "Staff guest",
      guestNote: "Window",
    });
    expect(row.startsAt).toEqual(new Date(SEVEN));
    expect(row.endsAt.toISOString()).toBe("2026-11-06T18:30:00.000Z");
    expect(row.holdEndsAt.toISOString()).toBe("2026-11-06T18:45:00.000Z");
    expect(row.manageToken).toMatch(/^[0-9A-Za-z]{22,}$/);
  });

  it("uses the restaurant's clock, not the server's: 19:00 in New York is midnight UTC", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db, { timezone: "America/New_York" });

    const row = await added(restaurantId);

    expect(row.startsAt.toISOString()).toBe("2026-11-07T00:00:00.000Z");
  });

  it("takes a table the guest's confirm would also refuse as taken, and the other way round", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db);
    const outcome = await confirmBooking({ restaurantId }, guest(), now);
    expect(outcome.outcome).toBe("confirmed");

    expect(await addStaffBooking(actor(restaurantId), request(), now)).toEqual({ outcome: "taken" });
    expect(await bookingsOf(owner.db, restaurantId)).toHaveLength(1);
  });

  it("is full when every table is held: no booking is made and nothing is audited", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, { tables: [{ capacity: 2 }, { capacity: 4 }] });
    await owner.db.insert(bookings).values(tableIds.map((id) => aBooking(restaurantId, id, SEVEN, QUARTER_TO_NINE)));

    const result = await addStaffBooking({ ...actor(restaurantId), platformAdminId: crypto.randomUUID() }, request(), now);

    expect(result).toEqual({ outcome: "taken" });
    expect(await bookingsOf(owner.db, restaurantId)).toHaveLength(2);
    expect(await auditOf(restaurantId)).toEqual([]);
  });

  it("a cancelled booking frees the table for staff too", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db);
    await owner.db
      .insert(bookings)
      .values({ ...aBooking(restaurantId, tableIds[0], SEVEN, QUARTER_TO_NINE), status: "cancelled" });

    expect((await added(restaurantId)).source).toBe("staff");
  });

  it("a time that isn't on the restaurant's grid, or has passed, is time_unavailable", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db);

    for (const time of ["19:10", "12:00", "23:30"]) {
      expect(await addStaffBooking(actor(restaurantId), request({ time }), now)).toEqual({ outcome: "time_unavailable" });
    }
    // 19:00 has passed at 19:05 local; staff can book inside the lead time but not the past.
    const late = new Date("2026-11-06T17:05:00Z");
    expect(await addStaffBooking(actor(restaurantId), request(), late)).toEqual({ outcome: "time_unavailable" });
    expect(await bookingsOf(owner.db, restaurantId)).toEqual([]);
  });

  it.each(["2026-11-04", "2026-12-06", "9999-12-31", "0001-01-01"])(
    "a date outside today to max_days_ahead (%s) is date_unavailable, not an error",
    async (outside) => {
      const { restaurantId } = await bookableRestaurant(owner.db);
      expect(await addStaffBooking(actor(restaurantId), request({ date: outside }), now)).toEqual({
        outcome: "date_unavailable",
      });
    },
  );

  it("the last bookable day is judged on the restaurant's calendar", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db, { rules: { maxDaysAhead: 1 } });
    // 23:30 UTC on the 5th is already the 6th in Harare, so the 7th is its last day.
    const lateUtc = new Date("2026-11-05T23:30:00Z");

    expect((await addStaffBooking(actor(restaurantId), request({ date: "2026-11-07" }), lateUtc)).outcome).toBe("added");
    expect(await addStaffBooking(actor(restaurantId), request({ date: "2026-11-08" }), lateUtc)).toEqual({
      outcome: "date_unavailable",
    });
  });

  it("books on while online booking is switched off: the switch is for guests", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db, { rules: { enabled: false } });

    expect((await added(restaurantId)).source).toBe("staff");
    expect((await confirmBooking({ restaurantId }, guest({ time: "20:00" }), now)).outcome).toBe("closed");
  });

  it("a party no table seats is no_fit", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db, { tables: [{ capacity: 4 }] });
    expect(await addStaffBooking(actor(restaurantId), request({ party: 5 }), now)).toEqual({ outcome: "no_fit" });
  });
});

describe("add booking: what staff may override", () => {
  it("inside the lead time, which the guest's confirm refuses", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db, { rules: { minLeadMinutes: 120 } });
    const soon = new Date("2026-11-06T16:30:00Z"); // 18:30 local, 30 minutes before the table

    expect((await confirmBooking({ restaurantId }, guest(), soon)).outcome).toBe("lead_time");
    const result = await addStaffBooking(actor(restaurantId), request(), soon);
    expect(result.outcome).toBe("added");
    // ...though the guest's list keeps its lead time for the next guest.
    expect((await confirmBooking({ restaurantId }, guest({ time: "19:30" }), soon)).outcome).toBe("lead_time");
  });

  it("above max_online_party_size, if a table seats the party", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 12 }],
      rules: { maxOnlinePartySize: 4 },
    });

    expect((await confirmBooking({ restaurantId }, guest({ party: 10 }), now)).outcome).toBe("party_too_large");
    expect((await added(restaurantId, { party: 10 })).partySize).toBe(10);
  });

  it("a large party gets the large-party sitting, from the same rules", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 12 }],
      rules: { largePartySize: 8, largePartySittingMinutes: 150, bufferMinutes: 15 },
    });

    const row = await added(restaurantId, { party: 10 });

    expect(row.holdEndsAt.getTime() - row.startsAt.getTime()).toBe(165 * 60_000);
  });

  it("by hand-picking the table, even a bigger one than best fit would give", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 2 }, { capacity: 8 }],
    });

    const row = await added(restaurantId, { tableId: tableIds[1] });

    expect(row.tableId).toBe(tableIds[1]);
  });

  it("onto a walk-ins-only table, which online never gets", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 4, bookable: false }, { capacity: 2 }],
    });

    expect((await confirmBooking({ restaurantId }, guest({ party: 3 }), now)).outcome).toBe("party_too_large");
    expect(await addStaffBooking(actor(restaurantId), request({ party: 3 }), now)).toEqual({ outcome: "no_fit" });
    const row = await added(restaurantId, { party: 3, tableId: tableIds[0] });
    expect(row.tableId).toBe(tableIds[0]);
  });

  it("automatic never lands on a walk-ins-only table", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 2, bookable: false }, { capacity: 4 }],
    });

    expect((await added(restaurantId)).tableId).toBe(tableIds[1]);
  });

  it("with the phone blank, stored as null through the E.164 check, with no WhatsApp consent", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db);
    const form = new FormData();
    for (const [key, value] of Object.entries({
      party: "2", date, time: "19:00", name: "Walk-up", countryCode: "+263", phone: "  ", whatsapp: "on",
    })) form.set(key, value);
    const parsed = parseStaffRequest(form);
    if (!parsed.success) throw new Error(parsed.message);

    const row = await added(restaurantId, parsed.data);

    expect(row.guestPhone).toBeNull();
    expect(row.whatsappOptIn).toBe(false);
  });

  it("past a phone's per-phone limit, because that rule is for online bookings", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 2 }, { capacity: 2 }, { capacity: 2 }],
      rules: { maxActiveBookingsPerPhone: 1 },
    });
    const future = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
    // One online booking holds the phone's only place...
    await owner.db.insert(bookings).values({
      ...aBooking(restaurantId, tableIds[0], future(48), future(50)),
      guestPhone: "+263771234567",
    });

    // ...and staff add two more for the same number.
    await added(restaurantId);
    await added(restaurantId, { time: "20:00" });

    const held = (await bookingsOf(owner.db, restaurantId)).filter((row) => row.guestPhone === "+263771234567");
    expect(held).toHaveLength(3);
    // The guest's own confirm for that number is still stopped.
    expect((await confirmBooking({ restaurantId }, guest({ time: "21:00" }), now)).outcome).toBe("phone_limit");
  });
});

describe("add booking: tables staff can't use", () => {
  it("an archived table is refused, even hand-picked", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, { tables: [{ capacity: 2 }, { capacity: 2 }] });
    await owner.db.update(diningTables).set({ archivedAt: new Date() }).where(eq(diningTables.id, tableIds[0]));

    expect(await addStaffBooking(actor(restaurantId), request({ tableId: tableIds[0] }), now)).toEqual({
      outcome: "table_archived",
    });
    expect(await bookingsOf(owner.db, restaurantId)).toEqual([]);
  });

  it("a table too small for the party is refused with its capacity", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, { tables: [{ capacity: 2 }] });

    expect(await addStaffBooking(actor(restaurantId), request({ party: 3, tableId: tableIds[0] }), now)).toEqual({
      outcome: "too_small",
      capacity: 2,
    });
  });

  it("a hand-picked table that is held then is taken, and the same table later is free", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, { tables: [{ capacity: 2 }, { capacity: 2 }] });
    await owner.db.insert(bookings).values(aBooking(restaurantId, tableIds[0], SEVEN, QUARTER_TO_NINE));

    expect(await addStaffBooking(actor(restaurantId), request({ tableId: tableIds[0] }), now)).toEqual({ outcome: "taken" });
    expect((await added(restaurantId, { tableId: tableIds[0], time: "21:00" })).tableId).toBe(tableIds[0]);
  });

  it("another restaurant's table, or one that doesn't exist, is table_not_found and books nothing", async () => {
    const mine = await bookableRestaurant(owner.db);
    const theirs = await bookableRestaurant(owner.db);

    for (const tableId of [theirs.tableIds[0], crypto.randomUUID(), "not-a-uuid", "a\0b"]) {
      expect(await addStaffBooking(actor(mine.restaurantId), request({ tableId }), now)).toEqual({
        outcome: "table_not_found",
      });
    }
    expect(await bookingsOf(owner.db, mine.restaurantId)).toEqual([]);
    expect(await bookingsOf(owner.db, theirs.restaurantId)).toEqual([]);
  });
});

describe("add booking: the audit log", () => {
  it("staff adding is not on spec 01's list, so nothing is written", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db);
    await added(restaurantId);
    expect(await auditOf(restaurantId)).toEqual([]);
  });

  it("an entered platform admin adding is audited as that admin, with no guest details", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db);
    const platformAdminId = crypto.randomUUID();

    const result = await addStaffBooking(
      actor(restaurantId, { platformAdminId }),
      request({ name: "Private Person" }),
      now,
    );

    if (result.outcome !== "added") throw new Error("not added");
    const entries = await auditOf(restaurantId);
    expect(entries).toEqual([
      expect.objectContaining({ actorType: "platform_admin", actorId: platformAdminId, action: "booking.create", entityId: result.id }),
    ]);
    expect(JSON.stringify(entries)).not.toContain("Private Person");
  });
});

describe("the staff request", () => {
  const form = (fields: Record<string, string>) => {
    const body = new FormData();
    for (const [key, value] of Object.entries({ party: "2", date, time: "19:00", name: "Tariro", ...fields })) {
      body.set(key, value);
    }
    return body;
  };

  it("makes E.164 of a local number, keeps its own country code, and treats blank as none", () => {
    expect(parseStaffRequest(form({ phone: "0771 234 567" }))).toMatchObject({ success: true, data: { phone: "+263771234567" } });
    expect(parseStaffRequest(form({ phone: "+44 7700 900123" }))).toMatchObject({ success: true, data: { phone: "+447700900123" } });
    expect(parseStaffRequest(form({ phone: "" }))).toMatchObject({ success: true, data: { phone: null } });
    expect(parseStaffRequest(form({}))).toMatchObject({ success: true, data: { phone: null } });
  });

  it.each(["abc", "123", "+0771234567", "1".repeat(41)])("refuses a phone that isn't one: %j", (phone) => {
    expect(parseStaffRequest(form({ phone }))).toMatchObject({ success: false });
  });

  it.each<Record<string, string>>([
    { party: "0" }, { party: "-1" }, { party: "1000" }, { party: "x" },
    { date: "2026-02-31" }, { date: "2026-13-01" }, { date: "yesterday" }, { date: "9999-12-31\0" },
    { time: "25:00" }, { time: "19:60" }, { time: "7pm" },
    { name: "   " }, { name: "x".repeat(101) }, { name: "a\0b" },
    { note: "x".repeat(201) }, { note: "a\0b" },
  ])("refuses a crafted field: %j", (fields) => {
    expect(parseStaffRequest(form(fields))).toMatchObject({ success: false });
  });

  it("consent needs a number: a ticked box with none is no consent", () => {
    expect(parseStaffRequest(form({ whatsapp: "on" }))).toMatchObject({ data: { whatsappOptIn: false } });
    expect(parseStaffRequest(form({ whatsapp: "on", phone: "0771234567" }))).toMatchObject({ data: { whatsappOptIn: true } });
  });

  it("is the staff form's own: the guest's parser ignores what only staff may send", () => {
    const body = new FormData();
    for (const [key, value] of Object.entries({
      party: "2", date, time: "19:00", name: "Guest", countryCode: "+263", phone: "0771234567",
      consent: "on", tableId: crypto.randomUUID(), source: "staff", status: "seated", minLeadMinutes: "0",
    })) body.set(key, value);

    const parsed = parseGuestRequest(body);

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Object.keys(parsed.data).sort()).toEqual(
        ["date", "name", "note", "party", "phone", "time", "whatsappOptIn"],
      );
    }
  });
});

describe("the add form's times", () => {
  it("lists the restaurant's times, and marks the ones with no bookable table free", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db);
    await owner.db.insert(bookings).values(aBooking(restaurantId, tableIds[0], SEVEN, QUARTER_TO_NINE));

    const form = await getStaffBookingForm({ restaurantId }, { party: "2", date }, now);

    expect(form.times?.map(({ time, open }) => `${time}${open ? "" : "!"}`)).toEqual([
      "18:00!", "18:30!", "19:00!", "19:30!", "20:00!", "20:30!", "21:00",
    ]);
  });

  it("ignores a party or date that isn't one, or lies outside the window", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db);

    for (const choice of [{ party: "0", date }, { party: "x", date }, { party: "2", date: "9999-12-31" }, { party: "2", date: "2026-11-04" }, { party: "2", date: "2026-02-31" }]) {
      const form = await getStaffBookingForm({ restaurantId }, choice, now);
      expect(form.times).toBeUndefined();
    }
  });
});

// --- concurrency ------------------------------------------------------------

/** Backends waiting on `holder`, by pid. */
const blockedBehind = (holder: number) =>
  vi.waitFor(
    async () => {
      const { rows } = await owner.db.execute<{ pid: number }>(sql`
        select pid from pg_stat_activity where ${holder} = any(pg_blocking_pids(pid))
      `);
      expect(rows).toHaveLength(1);
      return rows[0].pid;
    },
    { timeout: 5_000, interval: 20 },
  );

/** Holds a table's booking lock (the one #40's triggers meet on) for `inside`; always released. */
async function withTableLock<T>(
  tableId: string,
  inside: (holder: { pid: number; release: () => Promise<void> }) => Promise<T>,
) {
  const connection = await owner.pool.connect();
  try {
    await connection.query("begin");
    await connection.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`table_seat:${tableId}`]);
    const { rows } = await connection.query("select pg_backend_pid() as pid");
    return await inside({ pid: rows[0].pid, release: async () => void (await connection.query("commit")) });
  } finally {
    // Destroyed rather than returned: a failed test can leave it mid-transaction.
    connection.release(true);
  }
}

describe("two staff taking one table", () => {
  it("exactly one books it, and the other is told it was taken, not given an error", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db);

    const [a, b] = await withTableLock(tableIds[0], async (holder) => {
      // Each has read the table as free and inserted; the first insert is held
      // up behind the lock, so the second one waits on the first's row.
      const first = addStaffBooking(actor(restaurantId), request({ name: "First" }), now);
      const firstPid = await blockedBehind(holder.pid);
      const second = addStaffBooking(actor(restaurantId), request({ name: "Second" }), now);
      await blockedBehind(firstPid);
      await holder.release();
      return Promise.all([first, second]);
    });

    expect(a.outcome).toBe("added");
    expect(b).toEqual({ outcome: "taken" });
    const rows = await bookingsOf(owner.db, restaurantId);
    expect(rows).toHaveLength(1);
    expect(rows[0].guestName).toBe("First");
  });

  it("with a second table free, the loser of the first gets the second", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 2, sortOrder: 0 }, { capacity: 2, sortOrder: 1 }],
    });

    const [a, b] = await withTableLock(tableIds[0], async (holder) => {
      const first = addStaffBooking(actor(restaurantId), request({ name: "First" }), now);
      const firstPid = await blockedBehind(holder.pid);
      const second = addStaffBooking(actor(restaurantId), request({ name: "Second" }), now);
      await blockedBehind(firstPid);
      await holder.release();
      return Promise.all([first, second]);
    });

    expect([a.outcome, b.outcome]).toEqual(["added", "added"]);
    const tables = (await bookingsOf(owner.db, restaurantId)).map((row) => row.tableId);
    expect(new Set(tables).size).toBe(2);
  });

  it("a staff add and a guest's confirm for the last table: one wins", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db);

    const [staffResult, guestResult] = await withTableLock(tableIds[0], async (holder) => {
      const first = addStaffBooking(actor(restaurantId), request(), now);
      const firstPid = await blockedBehind(holder.pid);
      const second = confirmBooking({ restaurantId }, guest(), now);
      await blockedBehind(firstPid);
      await holder.release();
      return Promise.all([first, second]);
    });

    expect(staffResult.outcome).toBe("added");
    expect(guestResult.outcome).toBe("race_lost");
    expect(await bookingsOf(owner.db, restaurantId)).toHaveLength(1);
  });
});

// --- moving -----------------------------------------------------------------

async function twoTables(
  status: (typeof bookings.$inferSelect)["status"] = "confirmed",
  extra: Partial<typeof bookings.$inferInsert> = {},
  tables: { capacity: number; bookable?: boolean; label?: string }[] = [{ capacity: 2 }, { capacity: 2 }],
) {
  const { restaurantId, tableIds } = await bookableRestaurant(owner.db, { tables });
  const [booking] = await owner.db
    .insert(bookings)
    .values({ ...aBooking(restaurantId, tableIds[0], SEVEN, QUARTER_TO_NINE), status, ...extra })
    .returning();
  return { restaurantId, tableIds, booking };
}

describe("move table", () => {
  it("moves a confirmed booking to a free table, and audits who did it, with the two tables", async () => {
    const { restaurantId, tableIds, booking } = await twoTables();
    const mover = actor(restaurantId);

    const result = await moveBooking(mover, booking.id, tableIds[1]);

    expect(result).toEqual({ outcome: "moved", from: tableIds[0], to: tableIds[1] });
    expect(await rowOf(booking.id)).toEqual({ ...booking, tableId: tableIds[1] });
    expect(await auditOf(restaurantId)).toEqual([
      expect.objectContaining({
        actorType: "staff",
        actorId: mover.staffId,
        action: "booking.move",
        entityType: "booking",
        entityId: booking.id,
        details: { fromTableId: tableIds[0], toTableId: tableIds[1] },
      }),
    ]);
    expect(JSON.stringify(await auditOf(restaurantId))).not.toContain(booking.guestName);
  });

  it("by an entered platform admin is audited as that admin", async () => {
    const { restaurantId, tableIds, booking } = await twoTables();
    const platformAdminId = crypto.randomUUID();

    await moveBooking(actor(restaurantId, { platformAdminId }), booking.id, tableIds[1]);

    expect(await auditOf(restaurantId)).toEqual([
      expect.objectContaining({ actorType: "platform_admin", actorId: platformAdminId, action: "booking.move" }),
    ]);
  });

  it("frees the old table and takes the new one", async () => {
    const { restaurantId, tableIds, booking } = await twoTables();
    await moveBooking(actor(restaurantId), booking.id, tableIds[1]);

    await owner.db.insert(bookings).values(aBooking(restaurantId, tableIds[0], SEVEN, QUARTER_TO_NINE));
    await expect(
      owner.db.insert(bookings).values(aBooking(restaurantId, tableIds[1], SEVEN, QUARTER_TO_NINE)),
    ).rejects.toMatchObject({ cause: { constraint: "bookings_no_overlap" } });
  });

  it("onto a table whose hold overlaps by a minute: taken, and nothing changes or is audited", async () => {
    const { restaurantId, tableIds, booking } = await twoTables();
    await owner.db
      .insert(bookings)
      .values(aBooking(restaurantId, tableIds[1], "2026-11-06T18:44:00Z", "2026-11-06T20:00:00Z"));

    expect(await moveBooking(actor(restaurantId), booking.id, tableIds[1])).toEqual({ outcome: "taken" });

    expect(await rowOf(booking.id)).toEqual(booking);
    expect(await auditOf(restaurantId)).toEqual([]);
  });

  it("onto a table whose hold only touches the end of this one, or is cancelled, is fine", async () => {
    const { restaurantId, tableIds, booking } = await twoTables("confirmed", {}, [{ capacity: 2 }, { capacity: 2 }, { capacity: 2 }]);
    await owner.db.insert(bookings).values([
      aBooking(restaurantId, tableIds[1], QUARTER_TO_NINE, "2026-11-06T20:00:00Z"),
      { ...aBooking(restaurantId, tableIds[2], SEVEN, QUARTER_TO_NINE), status: "cancelled" as const },
    ]);

    expect((await moveBooking(actor(restaurantId), booking.id, tableIds[1])).outcome).toBe("moved");
    expect((await moveBooking(actor(restaurantId), booking.id, tableIds[2])).outcome).toBe("moved");
  });

  it.each(["seated", "completed", "cancelled", "no_show"] as const)(
    "a %s booking can't move: it is told what the booking is, and nothing changes",
    async (status) => {
      const { restaurantId, tableIds, booking } = await twoTables(status);

      expect(await moveBooking(actor(restaurantId), booking.id, tableIds[1])).toEqual({ outcome: "wrong_status", status });

      expect(await rowOf(booking.id)).toEqual(booking);
      expect(await auditOf(restaurantId)).toEqual([]);
    },
  );

  it("a table that seats fewer than the party is refused with both numbers", async () => {
    const { restaurantId, tableIds, booking } = await twoTables("confirmed", { partySize: 4 }, [{ capacity: 4 }, { capacity: 2 }]);

    expect(await moveBooking(actor(restaurantId), booking.id, tableIds[1])).toEqual({ outcome: "too_small", capacity: 2, party: 4 });
    expect((await rowOf(booking.id)).tableId).toBe(tableIds[0]);
  });

  it("a table that seats the party exactly is fine", async () => {
    const { restaurantId, tableIds, booking } = await twoTables("confirmed", { partySize: 4 }, [{ capacity: 6 }, { capacity: 4 }]);
    expect((await moveBooking(actor(restaurantId), booking.id, tableIds[1])).outcome).toBe("moved");
  });

  it("an archived table is refused", async () => {
    const { restaurantId, tableIds, booking } = await twoTables();
    await owner.db.update(diningTables).set({ archivedAt: new Date() }).where(eq(diningTables.id, tableIds[1]));

    expect(await moveBooking(actor(restaurantId), booking.id, tableIds[1])).toEqual({ outcome: "table_archived" });
    expect((await rowOf(booking.id)).tableId).toBe(tableIds[0]);
  });

  it("the table it is on is same_table", async () => {
    const { restaurantId, tableIds, booking } = await twoTables();
    expect(await moveBooking(actor(restaurantId), booking.id, tableIds[0])).toEqual({ outcome: "same_table" });
    expect(await auditOf(restaurantId)).toEqual([]);
  });

  it("a staff booking may move to a walk-ins-only table; an online one may not", async () => {
    const staffSide = await twoTables("confirmed", { source: "staff" }, [{ capacity: 2 }, { capacity: 2, bookable: false }]);
    const onlineSide = await twoTables("confirmed", { source: "online" }, [{ capacity: 2 }, { capacity: 2, bookable: false }]);

    expect((await moveBooking(actor(staffSide.restaurantId), staffSide.booking.id, staffSide.tableIds[1])).outcome).toBe("moved");
    expect(await moveBooking(actor(onlineSide.restaurantId), onlineSide.booking.id, onlineSide.tableIds[1])).toEqual({
      outcome: "walk_in_only",
    });
    expect((await rowOf(onlineSide.booking.id)).tableId).toBe(onlineSide.tableIds[0]);
  });

  it("another restaurant's table or booking, or an unknown one, is not found and changes nothing", async () => {
    const mine = await twoTables();
    const theirs = await twoTables();

    expect(await moveBooking(actor(mine.restaurantId), mine.booking.id, theirs.tableIds[1])).toEqual({ outcome: "table_not_found" });
    expect(await moveBooking(actor(mine.restaurantId), mine.booking.id, crypto.randomUUID())).toEqual({ outcome: "table_not_found" });
    expect(await moveBooking(actor(mine.restaurantId), theirs.booking.id, mine.tableIds[1])).toEqual({ outcome: "not_found" });
    expect(await moveBooking(actor(mine.restaurantId), crypto.randomUUID(), mine.tableIds[1])).toEqual({ outcome: "not_found" });

    expect(await rowOf(mine.booking.id)).toEqual(mine.booking);
    expect(await rowOf(theirs.booking.id)).toEqual(theirs.booking);
    expect(await auditOf(mine.restaurantId)).toEqual([]);
    expect(await auditOf(theirs.restaurantId)).toEqual([]);
  });

  it("moves the booking only: no other column changes", async () => {
    const { restaurantId, tableIds, booking } = await twoTables("confirmed", { guestPhone: "+263771234567" });
    await moveBooking(actor(restaurantId), booking.id, tableIds[1]);
    const after = await rowOf(booking.id);
    expect({ ...after, tableId: booking.tableId }).toEqual(booking);
  });
});

describe("move targets for the day view", () => {
  it("lists the tables free for the whole hold, never the booking's own, and nothing for a booking that can't move", async () => {
    const { restaurantId, tableIds, booking } = await twoTables("confirmed", {}, [
      { capacity: 2, label: "A" }, { capacity: 2, label: "B" }, { capacity: 2, label: "C" }, { capacity: 1, label: "D" },
    ]);
    await owner.db.insert(bookings).values([
      aBooking(restaurantId, tableIds[1], "2026-11-06T18:00:00Z", "2026-11-06T19:00:00Z"),
      { ...aBooking(restaurantId, tableIds[2], SEVEN, QUARTER_TO_NINE), status: "seated" as const },
      { ...aBooking(restaurantId, tableIds[3], SEVEN, QUARTER_TO_NINE) },
    ]);
    const [seated] = (await bookingsOf(owner.db, restaurantId)).filter((row) => row.status === "seated");

    const targets = await getMoveTargets({ restaurantId }, date);

    // B's earlier booking holds it until 21:00 local, so it overlaps; C is seated.
    expect(targets[booking.id]).toEqual([]);
    expect(targets[seated.id]).toBeUndefined();
  });

  it("offers a free table, and a walk-ins-only one to a staff booking only", async () => {
    const online = await twoTables("confirmed", { source: "online" }, [{ capacity: 2 }, { capacity: 4, label: "Walk" , bookable: false }, { capacity: 4, label: "Free" }]);
    const staffed = await twoTables("confirmed", { source: "staff" }, [{ capacity: 2 }, { capacity: 4, label: "Walk", bookable: false }, { capacity: 4, label: "Free" }]);

    const onlineTargets = (await getMoveTargets({ restaurantId: online.restaurantId }, date))[online.booking.id];
    const staffTargets = (await getMoveTargets({ restaurantId: staffed.restaurantId }, date))[staffed.booking.id];

    expect(onlineTargets.map((table) => table.label)).toEqual(["Free"]);
    expect(staffTargets.map((table) => `${table.label}${table.walkInOnly ? "*" : ""}`).sort()).toEqual(["Free", "Walk*"]);
  });

  it("reads a constant number of queries however many bookings", async () => {
    const { restaurantId } = await twoTables();
    const { countQueries } = await import("../../test/integration/queries");
    const few = await countQueries(() => getMoveTargets({ restaurantId }, date));
    for (let i = 0; i < 4; i++) {
      await owner.db.insert(bookings).values(aBooking(restaurantId, (await owner.db.select().from(diningTables).where(eq(diningTables.restaurantId, restaurantId)))[1].id, `2026-11-06T${String(8 + i).padStart(2, "0")}:00:00Z`, `2026-11-06T${String(8 + i).padStart(2, "0")}:30:00Z`));
    }
    const many = await countQueries(() => getMoveTargets({ restaurantId }, date));
    expect(many).toBe(few);
  });
});

// --- move races -------------------------------------------------------------

const queuedBehind = (holder: number, length: number) =>
  vi.waitFor(
    async () => {
      const { rows } = await owner.db.execute<{ pid: number }>(sql`
        with recursive queue(pid) as (
          select pid from pg_stat_activity where ${holder} = any(pg_blocking_pids(pid))
          union
          select waiting.pid from pg_stat_activity waiting
          join queue on queue.pid = any(pg_blocking_pids(waiting.pid))
        )
        select pid from queue`);
      expect(rows).toHaveLength(length);
    },
    { timeout: 5_000, interval: 20 },
  );

/** Starts `first`, then `second`, both stopped on the booking's row, then lets them go. */
async function inOrder<A, B>(id: string, first: () => Promise<A>, second: () => Promise<B>) {
  const holder = await owner.pool.connect();
  try {
    await holder.query("begin");
    await holder.query("select 1 from bookings where id = $1 for update", [id]);
    const { rows } = await holder.query("select pg_backend_pid() as pid");
    const pid = rows[0].pid as number;
    const a = first();
    await queuedBehind(pid, 1);
    const b = second();
    await queuedBehind(pid, 2);
    await holder.query("commit");
    return [await a, await b] as const;
  } finally {
    holder.release(true);
  }
}

describe("move targets and a walk-in", () => {
  it("a seated walk-in holds its table, so it is no target for the hold, and the walk-in itself can't move", async () => {
    const { restaurantId, tableIds, booking } = await twoTables("confirmed", {}, [
      { capacity: 2, label: "A" }, { capacity: 2, label: "B" }, { capacity: 2, label: "C" },
    ]);
    // 19:30 local on B: held to 21:15 local, across the booking's 19:00 to 20:45 hold.
    const seated = await seatWalkIn(actor(restaurantId), tableIds[1], 2, new Date("2026-11-06T17:30:00Z"));
    expect(seated.outcome).toBe("seated");
    const walkIn = (await bookingsOf(owner.db, restaurantId)).find((row) => row.guestName === "Walk-in")!;

    const targets = await getMoveTargets({ restaurantId }, date);

    expect(targets[booking.id]?.map((table) => table.label)).toEqual(["C"]);
    expect(targets[walkIn.id]).toBeUndefined();
    expect(await moveBooking(actor(restaurantId), walkIn.id, tableIds[2])).toEqual({
      outcome: "wrong_status",
      status: "seated",
    });
    expect(await rowOf(walkIn.id)).toMatchObject({ status: "seated", tableId: tableIds[1] });
  });
});

describe("a move racing a seat or a cancel", () => {
  it("seat first: the move is told the booking is seated, and the table stays where they sit", async () => {
    const { restaurantId, tableIds, booking } = await twoTables();
    const who = actor(restaurantId);

    const [seat, move] = await inOrder(booking.id, () => seatBooking(who, booking.id), () => moveBooking(who, booking.id, tableIds[1]));

    expect(seat).toEqual({ outcome: "done" });
    expect(move).toEqual({ outcome: "wrong_status", status: "seated" });
    expect(await rowOf(booking.id)).toMatchObject({ status: "seated", tableId: tableIds[0] });
    expect(await auditOf(restaurantId)).toEqual([]);
  });

  it("cancel first: the move is told the booking is cancelled, and no audit entry says it moved", async () => {
    const { restaurantId, tableIds, booking } = await twoTables();
    const who = actor(restaurantId);

    const [cancel, move] = await inOrder(booking.id, () => cancelBooking(who, booking.id), () => moveBooking(who, booking.id, tableIds[1]));

    expect(cancel).toEqual({ outcome: "done" });
    expect(move).toEqual({ outcome: "wrong_status", status: "cancelled" });
    expect(await rowOf(booking.id)).toMatchObject({ status: "cancelled", tableId: tableIds[0] });
    expect((await auditOf(restaurantId)).map((entry) => entry.action)).toEqual(["booking.cancel"]);
  });

  it("move first: the move stands, and the seat that follows lands on the new table", async () => {
    const { restaurantId, tableIds, booking } = await twoTables();
    const who = actor(restaurantId);

    const [move, seat] = await inOrder(booking.id, () => moveBooking(who, booking.id, tableIds[1]), () => seatBooking(who, booking.id));

    expect(move.outcome).toBe("moved");
    expect(seat).toEqual({ outcome: "done" });
    expect(await rowOf(booking.id)).toMatchObject({ status: "seated", tableId: tableIds[1] });
  });

  it("move first, then cancel: both stand, the cancel at the new table", async () => {
    const { restaurantId, tableIds, booking } = await twoTables();
    const who = actor(restaurantId);

    const [move, cancel] = await inOrder(booking.id, () => moveBooking(who, booking.id, tableIds[1]), () => cancelBooking(who, booking.id));

    expect(move.outcome).toBe("moved");
    expect(cancel).toEqual({ outcome: "done" });
    expect(await rowOf(booking.id)).toMatchObject({ status: "cancelled", tableId: tableIds[1] });
  });

  it("two bookings moved to one free table at once: one wins, the other is told it's taken", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, { tables: [{ capacity: 2 }, { capacity: 2 }, { capacity: 2 }] });
    const [one, two] = await owner.db
      .insert(bookings)
      .values([
        aBooking(restaurantId, tableIds[0], SEVEN, QUARTER_TO_NINE),
        aBooking(restaurantId, tableIds[1], SEVEN, QUARTER_TO_NINE),
      ])
      .returning();
    const who = actor(restaurantId);

    const [a, b] = await withTableLock(tableIds[2], async (holder) => {
      const first = moveBooking(who, one.id, tableIds[2]);
      const firstPid = await blockedBehind(holder.pid);
      const second = moveBooking(who, two.id, tableIds[2]);
      await blockedBehind(firstPid);
      await holder.release();
      return Promise.all([first, second]);
    });

    expect(a.outcome).toBe("moved");
    expect(b).toEqual({ outcome: "taken" });
    expect((await rowOf(one.id)).tableId).toBe(tableIds[2]);
    expect((await rowOf(two.id)).tableId).toBe(tableIds[1]);
    expect(await auditOf(restaurantId)).toHaveLength(1);
  });
});
