import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auditLog, bookings, servicePeriods } from "@/db/schema";
import {
  aBooking,
  bookableRestaurant,
  bookingsOf,
} from "../../test/integration/bookings";
import { openOwnerDatabase, testDatabaseSettings } from "../../test/integration/database";
import { countQueries } from "../../test/integration/queries";
import {
  cancelBooking,
  finishBooking,
  getDayView,
  HOLD_CAP_MINUTES,
  markNoShow,
  seatBooking,
} from "./booking-day";
import { confirmBooking, getBookingPage, type GuestRequest } from "./bookings";

/**
 * The staff day view and its actions against real rows, as app_tenant, on
 * restaurants of their own.
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
/** 19:00 to 20:30 in Harare, held to 20:45 by the default 15-minute buffer. */
const SEVEN = "2026-11-06T17:00:00Z";
const HALF_EIGHT = "2026-11-06T18:30:00Z";
const QUARTER_TO_NINE = "2026-11-06T18:45:00Z";

type Status = typeof bookings.$inferSelect.status;

const actor = (restaurantId: string) => ({ restaurantId, staffId: crypto.randomUUID() });

const guest = (overrides: Partial<GuestRequest> = {}): GuestRequest => ({
  party: 2,
  date,
  time: "20:00",
  name: "Online guest",
  phone: "+263771234567",
  note: null,
  whatsappOptIn: true,
  ...overrides,
});

/** A restaurant whose rules let the exact minute a table frees be seen. */
const sharp = { minLeadMinutes: 0, bufferMinutes: 15, slotIntervalMinutes: 30 };

async function oneBooking(status: Status = "confirmed", rules = sharp) {
  const { restaurantId, tableIds } = await bookableRestaurant(owner.db, { rules });
  const [booking] = await owner.db
    .insert(bookings)
    .values({ ...aBooking(restaurantId, tableIds[0], SEVEN, QUARTER_TO_NINE), endsAt: new Date(HALF_EIGHT), status })
    .returning();
  return { restaurantId, tableId: tableIds[0], booking };
}

const rowOf = async (id: string) =>
  (await owner.db.select().from(bookings).where(eq(bookings.id, id)))[0];

const auditOf = (restaurantId: string) =>
  owner.db.select().from(auditLog).where(eq(auditLog.restaurantId, restaurantId));

const iso = (value: Date) => value.toISOString();

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

/** Runs `inside` while a second connection holds an open transaction; always released. */
async function withHolder(
  inside: (holder: { query: (text: string) => Promise<unknown>; pid: number }) => Promise<void>,
) {
  const connection = await owner.pool.connect();
  try {
    await connection.query("begin");
    const { rows } = await connection.query("select pg_backend_pid() as pid");
    await inside({ query: (text) => connection.query(text), pid: rows[0].pid });
  } finally {
    // Destroyed rather than returned: a failed test can leave it mid-transaction.
    connection.release(true);
  }
}

// --- the actions ------------------------------------------------------------

const actions = {
  seat: { run: seatBooking, from: "confirmed", to: "seated" },
  "no-show": { run: markNoShow, from: "confirmed", to: "no_show" },
  cancel: { run: cancelBooking, from: "confirmed", to: "cancelled" },
  finish: { run: (a: ReturnType<typeof actor>, id: string) => finishBooking(a, id, new Date("2026-11-06T17:40:00Z")), from: "seated", to: "completed" },
} as const;
const statuses: Status[] = ["confirmed", "seated", "completed", "cancelled", "no_show"];

describe("every transition", () => {
  const valid = Object.entries(actions).map(([name, a]) => [name, a.from, a.to] as const);

  it.each(valid)("%s: %s becomes %s", async (name, from, to) => {
    const { restaurantId, booking } = await oneBooking(from);

    const result = await actions[name as keyof typeof actions].run(actor(restaurantId), booking.id);

    expect(result).toEqual({ outcome: "done" });
    expect((await rowOf(booking.id)).status).toBe(to);
  });

  const invalid = Object.entries(actions).flatMap(([name, a]) =>
    statuses.filter((status) => status !== a.from).map((status) => [name, status] as const),
  );
  it("covers every invalid pair", () => {
    expect(invalid).toHaveLength(4 * 4);
  });

  it.each(invalid)("%s from %s is refused with the current status, and changes nothing", async (name, status) => {
    const { restaurantId, booking } = await oneBooking(status);

    const result = await actions[name as keyof typeof actions].run(actor(restaurantId), booking.id);

    expect(result).toEqual({ outcome: "wrong_status", status });
    expect(await rowOf(booking.id)).toEqual(booking);
    expect(await auditOf(restaurantId)).toEqual([]);
  });

  it("an unknown booking is not_found", async () => {
    const { restaurantId } = await oneBooking();
    for (const run of Object.values(actions).map((a) => a.run)) {
      expect(await run(actor(restaurantId), crypto.randomUUID())).toEqual({ outcome: "not_found" });
    }
  });

  it.each(Object.keys(actions))("%s: another restaurant's booking is not_found and changes nothing", async (name) => {
    const mine = await oneBooking();
    const theirs = await oneBooking(actions[name as keyof typeof actions].from);

    const result = await actions[name as keyof typeof actions].run(actor(mine.restaurantId), theirs.booking.id);

    expect(result).toEqual({ outcome: "not_found" });
    expect(await rowOf(theirs.booking.id)).toEqual(theirs.booking);
  });

  it("nothing leads out of no_show or cancelled, so a freed table can't be claimed back", async () => {
    const { restaurantId, tableId, booking } = await oneBooking();
    await markNoShow(actor(restaurantId), booking.id);
    // Someone else takes the freed table, as the constraint now allows.
    await owner.db
      .insert(bookings)
      .values(aBooking(restaurantId, tableId, SEVEN, QUARTER_TO_NINE));

    for (const run of [seatBooking, cancelBooking, markNoShow, finishBooking]) {
      expect(await run(actor(restaurantId), booking.id)).toMatchObject({ outcome: "wrong_status" });
    }
    expect((await rowOf(booking.id)).status).toBe("no_show");
  });
});

describe("cancel", () => {
  it("records staff, when, and an audit entry for the person who did it, without guest details", async () => {
    const { restaurantId, booking } = await oneBooking();
    const staffId = crypto.randomUUID();

    await cancelBooking({ restaurantId, staffId }, booking.id);

    const row = await rowOf(booking.id);
    expect(row).toMatchObject({ status: "cancelled", cancelledBy: "staff" });
    expect(Math.abs(row.cancelledAt!.getTime() - Date.now())).toBeLessThan(60_000);
    const entries = await auditOf(restaurantId);
    expect(entries).toEqual([
      expect.objectContaining({
        actorType: "staff",
        actorId: staffId,
        action: "booking.cancel",
        entityType: "booking",
        entityId: booking.id,
      }),
    ]);
    expect(JSON.stringify(entries)).not.toContain(booking.guestName);
  });

  it("by an entered platform admin is audited as that admin", async () => {
    const { restaurantId, booking } = await oneBooking();
    const platformAdminId = crypto.randomUUID();

    await cancelBooking({ restaurantId, staffId: crypto.randomUUID(), platformAdminId }, booking.id);

    expect(await auditOf(restaurantId)).toEqual([
      expect.objectContaining({ actorType: "platform_admin", actorId: platformAdminId, action: "booking.cancel" }),
    ]);
  });

  it("frees the table: the same hold can be booked again", async () => {
    const { restaurantId, tableId, booking } = await oneBooking();
    await cancelBooking(actor(restaurantId), booking.id);

    await owner.db.insert(bookings).values(aBooking(restaurantId, tableId, SEVEN, QUARTER_TO_NINE));

    expect(await bookingsOf(owner.db, restaurantId)).toHaveLength(2);
  });
});

describe("seat, no-show and finish: the audit list", () => {
  const unaudited = [
    ["seat", "confirmed"],
    ["no-show", "confirmed"],
    ["finish", "seated"],
  ] as const;

  it.each(unaudited)("%s by staff writes no entry: spec 01 lists only cancellations and moves", async (name, from) => {
    const { restaurantId, booking } = await oneBooking(from);
    await actions[name].run(actor(restaurantId), booking.id);
    expect(await auditOf(restaurantId)).toEqual([]);
  });

  it.each(unaudited)("%s by an entered platform admin is audited as that admin (S-28)", async (name, from) => {
    const { restaurantId, booking } = await oneBooking(from);
    const platformAdminId = crypto.randomUUID();

    await actions[name].run({ ...actor(restaurantId), platformAdminId }, booking.id);

    const verb = { seat: "seat", "no-show": "no_show", finish: "finish" }[name];
    expect(await auditOf(restaurantId)).toEqual([
      expect.objectContaining({ actorType: "platform_admin", actorId: platformAdminId, action: `booking.${verb}`, entityId: booking.id }),
    ]);
  });

  it("a refused action writes no entry", async () => {
    const { restaurantId, booking } = await oneBooking("completed");
    await cancelBooking({ ...actor(restaurantId), platformAdminId: crypto.randomUUID() }, booking.id);
    expect(await auditOf(restaurantId)).toEqual([]);
  });
});

describe("two actions at once", () => {
  it.each([
    ["seat twice", [seatBooking, seatBooking]],
    ["seat and no-show", [seatBooking, markNoShow]],
    ["cancel and no-show", [cancelBooking, markNoShow]],
  ] as const)("%s: exactly one wins and the other is told what it is now", async (_name, pair) => {
    const { restaurantId, booking } = await oneBooking();

    const results = await Promise.all(pair.map((run) => run(actor(restaurantId), booking.id)));

    expect(results.filter((r) => r.outcome === "done")).toHaveLength(1);
    const loser = results.find((r) => r.outcome !== "done");
    expect(loser).toEqual({ outcome: "wrong_status", status: (await rowOf(booking.id)).status });
  });

  it("a staff cancel racing the guest's own cancel: the guest's cancel wins, and staff are told", async () => {
    const { restaurantId, booking } = await oneBooking();
    await withHolder(async (holder) => {
      await holder.query(
        `update bookings set status = 'cancelled', cancelled_by = 'guest', cancelled_at = now()
         where id = '${booking.id}' and status = 'confirmed'`,
      );
      const staff = cancelBooking(actor(restaurantId), booking.id);
      await blockedBehind(holder.pid);
      await holder.query("commit");

      expect(await staff).toEqual({ outcome: "wrong_status", status: "cancelled" });
    });
    expect(await rowOf(booking.id)).toMatchObject({ status: "cancelled", cancelledBy: "guest" });
    expect(await auditOf(restaurantId)).toEqual([]);
  });

  it("the reverse: a guest's cancel arriving after staff seated finds nothing to cancel", async () => {
    const { restaurantId, booking } = await oneBooking();
    await seatBooking(actor(restaurantId), booking.id);

    const { rowCount } = await owner.pool.query(
      `update bookings set status = 'cancelled', cancelled_by = 'guest' where id = $1 and status = 'confirmed'`,
      [booking.id],
    );

    expect(rowCount).toBe(0);
    expect((await rowOf(booking.id)).status).toBe("seated");
  });
});

// --- freeing a table --------------------------------------------------------

describe("finish", () => {
  const timesAt = async (restaurantId: string, at: Date) =>
    (await getBookingPage({ restaurantId }, { party: "2", date }, at)).times?.map((t) => t.time);

  // 19:45 in Harare: the party is 45 minutes into a 90-minute sitting.
  const earlyFinish = new Date("2026-11-06T17:45:00Z");

  it("sets ends_at to now and hold_ends_at to now plus the buffer", async () => {
    const { restaurantId, booking } = await oneBooking("seated");

    await finishBooking(actor(restaurantId), booking.id, earlyFinish);

    const row = await rowOf(booking.id);
    expect([row.status, iso(row.endsAt), iso(row.holdEndsAt)]).toEqual([
      "completed",
      "2026-11-06T17:45:00.000Z",
      "2026-11-06T18:00:00.000Z",
    ]);
  });

  it("makes the table bookable from now plus the buffer, as the availability list and confirm see it", async () => {
    const { restaurantId, tableId, booking } = await oneBooking("seated");
    expect(await timesAt(restaurantId, earlyFinish)).not.toContain("20:00");

    await finishBooking(actor(restaurantId), booking.id, earlyFinish);

    // 20:00 is now + 15 minutes. 19:30 is still inside the party's time.
    const times = await timesAt(restaurantId, earlyFinish);
    expect(times).toContain("20:00");
    expect(times).not.toContain("19:30");
    expect((await confirmBooking({ restaurantId }, guest(), earlyFinish)).outcome).toBe("confirmed");
    const [theirs] = (await bookingsOf(owner.db, restaurantId)).filter((b) => b.guestName === "Online guest");
    expect(theirs.tableId).toBe(tableId);
  });

  it("frees the table at the minute now + buffer, not before: the constraint draws the line", async () => {
    const { restaurantId, tableId, booking } = await oneBooking("seated");
    await finishBooking(actor(restaurantId), booking.id, earlyFinish);

    const book = (start: string, end: string) =>
      owner.db.insert(bookings).values(aBooking(restaurantId, tableId, start, end));

    await expect(book("2026-11-06T17:59:00Z", "2026-11-06T19:00:00Z")).rejects.toMatchObject({
      cause: { code: "23P01" },
    });
    await expect(book("2026-11-06T18:00:00Z", "2026-11-06T19:00:00Z")).resolves.toBeDefined();
  });

  it("never ends before it starts: finishing a booking the instant it was seated keeps one minute", async () => {
    const { restaurantId, booking } = await oneBooking("seated");

    await finishBooking(actor(restaurantId), booking.id, new Date("2026-11-06T16:00:00Z"));

    const row = await rowOf(booking.id);
    expect([iso(row.endsAt), iso(row.holdEndsAt)]).toEqual([
      "2026-11-06T17:01:00.000Z",
      "2026-11-06T17:16:00.000Z",
    ]);
  });

  it("a seated booking finished the next morning succeeds, with the time it really ended", async () => {
    const { restaurantId, booking } = await oneBooking("seated");

    // 08:00 the next day: 13 hours after it started.
    const result = await finishBooking(actor(restaurantId), booking.id, new Date("2026-11-07T06:00:00Z"));

    expect(result).toEqual({ outcome: "done" });
    const row = await rowOf(booking.id);
    expect([row.status, iso(row.endsAt), iso(row.holdEndsAt)]).toEqual([
      "completed",
      "2026-11-07T06:00:00.000Z",
      "2026-11-07T06:15:00.000Z",
    ]);
  });

  it("past the 960-minute cap the buffer gives way first, then ends_at, and the row is still legal", async () => {
    const cap = HOLD_CAP_MINUTES * 60_000;
    const starts = new Date(SEVEN).getTime();

    // 5 minutes of room under the cap: ends_at is real, the buffer shrinks.
    const near = await oneBooking("seated");
    await finishBooking(actor(near.restaurantId), near.booking.id, new Date(starts + cap - 5 * 60_000));
    let row = await rowOf(near.booking.id);
    expect([row.endsAt.getTime() - starts, row.holdEndsAt.getTime() - starts]).toEqual([cap - 5 * 60_000, cap]);

    // Well past it: both stop at the cap.
    const past = await oneBooking("seated");
    expect(await finishBooking(actor(past.restaurantId), past.booking.id, new Date(starts + 2 * cap))).toEqual({
      outcome: "done",
    });
    row = await rowOf(past.booking.id);
    expect([row.endsAt.getTime() - starts, row.holdEndsAt.getTime() - starts]).toEqual([cap, cap]);
  });

  it("a party that stayed past its hold ends where the next booking on the table begins, never inside it", async () => {
    const { restaurantId, tableId, booking } = await oneBooking("seated");
    // Booked from the minute the first hold ends.
    await owner.db
      .insert(bookings)
      .values(aBooking(restaurantId, tableId, QUARTER_TO_NINE, "2026-11-06T20:30:00Z"));

    // 21:00 in Harare, 15 minutes after that booking was due.
    const result = await finishBooking(actor(restaurantId), booking.id, new Date("2026-11-06T19:00:00Z"));

    expect(result).toEqual({ outcome: "done" });
    const row = await rowOf(booking.id);
    expect([iso(row.endsAt), iso(row.holdEndsAt)]).toEqual([QUARTER_TO_NINE, QUARTER_TO_NINE].map((t) => new Date(t).toISOString()));
  });

  it("an overstay with nothing booked after it holds the table through the reset buffer", async () => {
    const { restaurantId, booking } = await oneBooking("seated");

    await finishBooking(actor(restaurantId), booking.id, new Date("2026-11-06T19:00:00Z"));

    const row = await rowOf(booking.id);
    expect([iso(row.endsAt), iso(row.holdEndsAt)]).toEqual(["2026-11-06T19:00:00.000Z", "2026-11-06T19:15:00.000Z"]);
  });

  it("a booking that lands in the stretched hold at the same moment is told so, and the booking stays seated", async () => {
    const { restaurantId, tableId, booking } = await oneBooking("seated");
    await withHolder(async (holder) => {
      // Not committed, so Finish can't see it when it works out how far to stretch.
      await holder.query(`
        insert into bookings (restaurant_id, table_id, guest_name, whatsapp_opt_in, party_size,
          starts_at, ends_at, hold_ends_at, status, source, manage_token)
        values ('${restaurantId}', '${tableId}', 'Landed', true, 2,
          '2026-11-06T18:50:00Z', '2026-11-06T19:30:00Z', '2026-11-06T19:45:00Z', 'confirmed', 'online',
          '${crypto.randomUUID().replaceAll("-", "")}')`);
      const finishing = finishBooking(actor(restaurantId), booking.id, new Date("2026-11-06T19:00:00Z"));
      await blockedBehind(holder.pid);
      await holder.query("commit");

      expect(await finishing).toEqual({ outcome: "table_taken" });
    });
    expect((await rowOf(booking.id)).status).toBe("seated");
    expect(await auditOf(restaurantId)).toEqual([]);
  });

  it("two Finish taps at once: one wins", async () => {
    const { restaurantId, booking } = await oneBooking("seated");

    const results = await Promise.all([
      finishBooking(actor(restaurantId), booking.id, earlyFinish),
      finishBooking(actor(restaurantId), booking.id, earlyFinish),
    ]);

    expect(results.map((r) => r.outcome).sort()).toEqual(["done", "wrong_status"]);
  });
});

describe("no-show and cancel free the table", () => {
  it.each([
    ["no-show", markNoShow],
    ["cancel", cancelBooking],
  ])("%s: online booking offers the time again, and confirm takes it", async (_name, run) => {
    const { restaurantId, booking } = await oneBooking("confirmed");
    const at = new Date("2026-11-06T15:00:00Z");
    const times = async () =>
      (await getBookingPage({ restaurantId }, { party: "2", date }, at)).times?.map((t) => t.time);
    expect(await times()).not.toContain("19:00");

    await run(actor(restaurantId), booking.id);

    expect(await times()).toContain("19:00");
    expect((await confirmBooking({ restaurantId }, guest({ time: "19:00" }), at)).outcome).toBe("confirmed");
  });

  it("seating keeps the hold: the table stays taken", async () => {
    const { restaurantId, booking } = await oneBooking("confirmed");
    await seatBooking(actor(restaurantId), booking.id);

    const times = (
      await getBookingPage({ restaurantId }, { party: "2", date }, new Date("2026-11-06T15:00:00Z"))
    ).times?.map((t) => t.time);

    expect(times).not.toContain("19:00");
    expect(times).not.toContain("20:00");
  });
});

// --- the day ----------------------------------------------------------------

describe("the day view", () => {
  const at = (restaurantId: string, tableId: string, start: string, end: string, guestName: string) => ({
    ...aBooking(restaurantId, tableId, start, end),
    guestName,
  });

  it("is today on the restaurant's calendar, by time, with table and status", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 2, label: "Window" }, { capacity: 2, label: "Corner" }],
    });
    await owner.db.insert(bookings).values([
      at(restaurantId, tableIds[0], "2026-11-05T21:30:00Z", "2026-11-05T21:45:00Z", "Last night"), // 23:30 on the 5th
      at(restaurantId, tableIds[0], "2026-11-06T17:00:00Z", "2026-11-06T18:00:00Z", "Later"),
      { ...at(restaurantId, tableIds[1], "2026-11-05T22:00:00Z", "2026-11-05T23:00:00Z", "At midnight"), status: "cancelled" as const },
      at(restaurantId, tableIds[0], "2026-11-06T21:59:00Z", "2026-11-06T22:30:00Z", "Last minute"), // 23:59 on the 6th
      at(restaurantId, tableIds[0], "2026-11-06T22:30:00Z", "2026-11-06T23:00:00Z", "Tomorrow"), // 00:30 on the 7th
    ]);

    // 00:30 on the 6th in Harare, still the 5th in UTC.
    const view = await getDayView({ restaurantId }, undefined, new Date("2026-11-05T22:30:00Z"));

    expect(view.dateLabel).toBe("Fri 6 Nov");
    expect(view.isToday).toBe(true);
    // Dinner is 18:00 to 23:00 here, so the midnight and 23:59 bookings are Other.
    expect(
      view.groups.map((g) => [
        g.name,
        g.rows.map(({ time, guestName, table, status, partySize }) => [time, guestName, table, status, partySize]),
      ]),
    ).toEqual([
      ["Dinner", [["19:00", "Later", "Window", "confirmed", 2]]],
      [
        "Other",
        [
          ["00:00", "At midnight", "Corner", "cancelled", 2],
          ["23:59", "Last minute", "Window", "confirmed", 2],
        ],
      ],
    ]);
  });

  it("shows nothing from another restaurant", async () => {
    const mine = await bookableRestaurant(owner.db);
    const theirs = await bookableRestaurant(owner.db);
    await owner.db
      .insert(bookings)
      .values(aBooking(theirs.restaurantId, theirs.tableIds[0], SEVEN, QUARTER_TO_NINE));

    const view = await getDayView({ restaurantId: mine.restaurantId }, date, now);

    expect(view.groups.flatMap((g) => g.rows)).toEqual([]);
  });

  it("groups by service period with counts and covers, and puts the rest under Other", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 8 }, { capacity: 8 }],
    });
    await owner.db.insert(servicePeriods).values({
      restaurantId,
      name: "Lunch",
      weekday: 5,
      opensAt: "12:00",
      lastBookingAt: "14:00",
      closesAt: "15:00",
    });
    const row = (table: number, local: string, minutes: number, guestName: string, extra = {}) => {
      const start = new Date(`${date}T${local}:00+02:00`);
      const end = new Date(start.getTime() + minutes * 60_000);
      return {
        ...aBooking(restaurantId, tableIds[table], iso(start), iso(end)),
        guestName,
        ...extra,
      };
    };
    await owner.db.insert(bookings).values([
      row(0, "12:30", 60, "Lunch one", { partySize: 3 }),
      row(0, "19:00", 90, "Dinner one", { partySize: 4 }),
      row(1, "19:30", 90, "Dinner two", { partySize: 2, status: "seated" }),
      row(1, "21:30", 60, "Dinner cancelled", { partySize: 6, status: "cancelled" }),
      row(0, "16:00", 60, "Afternoon", { partySize: 5 }),
      row(0, "23:00", 30, "After close", { partySize: 1 }), // closes_at is exclusive
    ]);

    const view = await getDayView({ restaurantId }, date, now);

    expect(view.groups.map((g) => [g.name, g.bookingCount, g.covers, g.rows.map((r) => r.guestName)])).toEqual([
      ["Lunch", 1, 3, ["Lunch one"]],
      ["Dinner", 2, 6, ["Dinner one", "Dinner two", "Dinner cancelled"]],
      ["Other", 2, 6, ["Afternoon", "After close"]],
    ]);
  });

  it("works out periods and the day in the restaurant's zone, not the server's, around midnight too", async () => {
    // Los Angeles is UTC-8 on 6 Nov. Dinner is on Fridays only.
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, {
      timezone: "America/Los_Angeles",
    });
    await owner.db.delete(servicePeriods).where(eq(servicePeriods.restaurantId, restaurantId));
    await owner.db.insert(servicePeriods).values({
      restaurantId,
      name: "Dinner",
      weekday: 5,
      opensAt: "18:00",
      lastBookingAt: "21:00",
      closesAt: "23:00",
    });
    await owner.db.insert(bookings).values([
      // Friday 20:00 in LA is Saturday 04:00 in UTC: the weekday must be Friday's.
      at(restaurantId, tableIds[0], "2026-11-07T04:00:00Z", "2026-11-07T05:30:00Z", "Friday dinner"),
      // Friday 23:30 in LA: still Friday, and Saturday 07:30 in UTC.
      at(restaurantId, tableIds[0], "2026-11-07T07:30:00Z", "2026-11-07T08:00:00Z", "Friday late"),
      // Saturday 00:30 in LA: not on Friday's page.
      at(restaurantId, tableIds[0], "2026-11-07T08:30:00Z", "2026-11-07T09:00:00Z", "Saturday early"),
    ]);

    const friday = await getDayView({ restaurantId }, date, new Date("2026-11-06T20:00:00Z"));
    const saturday = await getDayView({ restaurantId }, "2026-11-07", new Date("2026-11-06T20:00:00Z"));

    expect(friday.groups.map((g) => [g.name, g.rows.map((r) => [r.guestName, r.time])])).toEqual([
      ["Dinner", [["Friday dinner", "20:00"]]],
      ["Other", [["Friday late", "23:30"]]],
    ]);
    expect(saturday.groups.flatMap((g) => g.rows.map((r) => [r.guestName, r.time]))).toEqual([
      ["Saturday early", "00:30"],
    ]);
    expect(saturday.groups.map((g) => g.name)).toEqual(["Other"]);
  });

  it("marks a confirmed booking Late 30 minutes after its start, and only then", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, { tables: [{ capacity: 2 }, { capacity: 2 }] });
    await owner.db.insert(bookings).values([
      at(restaurantId, tableIds[0], SEVEN, QUARTER_TO_NINE, "Waiting"),
      { ...at(restaurantId, tableIds[1], SEVEN, QUARTER_TO_NINE, "Seated"), status: "seated" as const },
    ]);
    const lateOf = async (when: string) =>
      Object.fromEntries(
        (await getDayView({ restaurantId }, date, new Date(when))).groups.flatMap((g) => g.rows).map((r) => [r.guestName, r.late]),
      );

    expect(await lateOf("2026-11-06T17:29:59Z")).toEqual({ Waiting: false, Seated: false });
    expect(await lateOf("2026-11-06T17:30:00Z")).toEqual({ Waiting: true, Seated: false });
  });

  it("carries the phone and note the buttons and rows need", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db);
    await owner.db.insert(bookings).values({
      ...aBooking(restaurantId, tableIds[0], SEVEN, QUARTER_TO_NINE),
      guestPhone: "+263771234567",
      guestNote: "Birthday",
    });

    const [row] = (await getDayView({ restaurantId }, date, now)).groups.flatMap((g) => g.rows);

    expect([row.phone, row.note]).toEqual(["+263771234567", "Birthday"]);
  });

  it.each([
    "2026-02-31",
    "9999-12-31",
    "0000-01-01",
    "not a date",
    "2026-11-06\0",
    "x".repeat(100_000),
    "2030-01-01",
    "2020-01-01",
  ])("a crafted date (%.20j) shows today and says so, not an error", async (value) => {
    const { restaurantId } = await bookableRestaurant(owner.db);

    const view = await getDayView({ restaurantId }, value, now);

    expect(view).toMatchObject({ date: "2026-11-05", refused: true, isToday: true });
  });

  it("makes the same number of queries for one booking as for thirty", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, {
      tables: Array.from({ length: 30 }, () => ({ capacity: 2 })),
    });
    const count = () => countQueries(() => getDayView({ restaurantId }, date, now));

    await owner.db.insert(bookings).values(at(restaurantId, tableIds[0], SEVEN, QUARTER_TO_NINE, "One"));
    const one = await count();
    await owner.db.insert(bookings).values(
      tableIds.slice(1).map((id, index) => at(restaurantId, id, SEVEN, QUARTER_TO_NINE, `Guest ${index}`)),
    );

    expect(await count()).toBe(one);
    expect(one).toBeGreaterThan(0);
  });
});
