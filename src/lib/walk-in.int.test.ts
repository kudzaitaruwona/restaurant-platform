import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auditLog, bookings, diningTables } from "@/db/schema";
import { aBooking, bookableRestaurant, bookingsOf } from "../../test/integration/bookings";
import { openOwnerDatabase, testDatabaseSettings } from "../../test/integration/database";
import { addStaffBooking } from "./booking-staff";
import { confirmBooking, getBookingPage, type GuestRequest } from "./bookings";
import { seatWalkIn, WALK_IN_MIN_MINUTES, walkInTables } from "./walk-in";
import { walkInResponse } from "./walk-in-responses";

/** Seat walk-in against real rows, as app_tenant, on restaurants of their own. */
const owner = openOwnerDatabase();

beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});
afterAll(async () => {
  await owner.pool.end();
  vi.unstubAllEnvs();
});

const MINUTE = 60_000;
// 19:00 on Friday 6 Nov in Harare (UTC+2, no daylight saving).
const NOW = new Date("2026-11-06T17:00:00Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * MINUTE);
const iso = (value: Date) => value.toISOString();
const date = "2026-11-06";
const actor = (restaurantId: string) => ({ restaurantId, staffId: crypto.randomUUID() });

/** Sitting 90 (120 from five), buffer 15: the defaults, spelled out. */
const rules = { sittingMinutes: 90, largePartySize: 5, largePartySittingMinutes: 120, bufferMinutes: 15, minLeadMinutes: 0 };

async function restaurant(overrides: Parameters<typeof bookableRestaurant>[1] = {}) {
  const made = await bookableRestaurant(owner.db, { rules, ...overrides });
  return { ...made, tableId: made.tableIds[0], actor: actor(made.restaurantId) };
}

/** A booking on the table from `startsInMin` for `heldMin`, relative to NOW. */
const bookOn = (
  restaurantId: string,
  tableId: string,
  startsInMin: number,
  heldMin: number,
  extra: Partial<typeof bookings.$inferInsert> = {},
) =>
  owner.db
    .insert(bookings)
    .values({
      ...aBooking(restaurantId, tableId, iso(at(startsInMin)), iso(at(startsInMin + heldMin))),
      endsAt: at(startsInMin + heldMin - 15),
      ...extra,
    })
    .returning();

const walkInsOf = async (restaurantId: string) =>
  (await bookingsOf(owner.db, restaurantId)).filter((row) => row.guestName === "Walk-in");

describe("what a walk-in is", () => {
  it("is a seated staff booking starting now, with no phone and no WhatsApp opt-in", async () => {
    const { restaurantId, tableId, actor: who } = await restaurant();

    const result = await seatWalkIn(who, tableId, 2, NOW);

    expect(result).toMatchObject({ outcome: "seated" });
    const [row] = await walkInsOf(restaurantId);
    expect(row).toMatchObject({
      guestName: "Walk-in",
      guestPhone: null,
      whatsappOptIn: false,
      status: "seated",
      source: "staff",
      partySize: 2,
      tableId,
    });
    expect(iso(row.startsAt)).toBe(iso(NOW));
  });

  it("with nothing booked after it, ends at now + the sitting and holds the buffer more", async () => {
    const { restaurantId, tableId, actor: who } = await restaurant();

    await seatWalkIn(who, tableId, 2, NOW);

    const [row] = await walkInsOf(restaurantId);
    expect([iso(row.endsAt), iso(row.holdEndsAt)]).toEqual([iso(at(90)), iso(at(105))]);
  });

  it("uses the large-party sitting from the party size the settings name", async () => {
    const { restaurantId, tableId, actor: who } = await restaurant({ tables: [{ capacity: 8 }] });

    await seatWalkIn(who, tableId, 5, NOW);

    const [row] = await walkInsOf(restaurantId);
    expect(iso(row.endsAt)).toBe(iso(at(120)));
  });

  it("the largest sitting and buffer still fit the 960-minute cap", async () => {
    const { restaurantId, tableId, actor: who } = await restaurant({
      rules: { ...rules, sittingMinutes: 720, bufferMinutes: 240 },
    });

    expect(await seatWalkIn(who, tableId, 2, NOW)).toMatchObject({ outcome: "seated" });
    const [row] = await walkInsOf(restaurantId);
    expect(row.holdEndsAt.getTime() - row.startsAt.getTime()).toBe(960 * MINUTE);
  });

  it("without a clock passed in, starts at the database's now()", async () => {
    const { restaurantId, tableId, actor: who } = await restaurant();

    await seatWalkIn(who, tableId, 2);

    const [row] = await walkInsOf(restaurantId);
    const { rows } = await owner.db.execute<{ ms: number }>(sql`select extract(epoch from now()) * 1000 as ms`);
    expect(Math.abs(row.startsAt.getTime() - Number(rows[0].ms))).toBeLessThan(10_000);
    expect(row.endsAt.getTime() - row.startsAt.getTime()).toBe(90 * MINUTE);
  });
});

describe("the next booking and the buffer", () => {
  it("a booking later than the sitting leaves the sitting alone", async () => {
    const { restaurantId, tableId, actor: who } = await restaurant();
    await bookOn(restaurantId, tableId, 240, 105);

    await seatWalkIn(who, tableId, 2, NOW);

    const [row] = await walkInsOf(restaurantId);
    expect(iso(row.endsAt)).toBe(iso(at(90)));
  });

  it("a booking inside the sitting cuts it so the hold ends exactly where that booking starts", async () => {
    const { restaurantId, tableId, actor: who } = await restaurant();
    await bookOn(restaurantId, tableId, 100, 105);

    expect(await seatWalkIn(who, tableId, 2, NOW)).toMatchObject({ outcome: "seated" });

    const [row] = await walkInsOf(restaurantId);
    expect(iso(row.endsAt)).toBe(iso(at(85)));
    expect(iso(row.holdEndsAt)).toBe(iso(at(100)));
  });

  it("exactly 30 minutes of room before the booking's buffer is seated", async () => {
    const { restaurantId, tableId, actor: who } = await restaurant();
    await bookOn(restaurantId, tableId, 15 + WALK_IN_MIN_MINUTES, 105);

    expect(await seatWalkIn(who, tableId, 2, NOW)).toMatchObject({ outcome: "seated" });

    const [row] = await walkInsOf(restaurantId);
    expect(iso(row.endsAt)).toBe(iso(at(30)));
  });

  it("a second less than 30 minutes is refused with the booking's time on the restaurant's clock", async () => {
    const { restaurantId, tableId, actor: who } = await restaurant();
    await bookOn(restaurantId, tableId, 15 + WALK_IN_MIN_MINUTES, 105);

    const result = await seatWalkIn(who, tableId, 2, new Date(NOW.getTime() + 1000));

    // The booking is at 19:45 Harare.
    expect(result).toEqual({ outcome: "booking_soon", table: "T1", at: "19:45" });
    expect(await walkInsOf(restaurantId)).toEqual([]);
  });

  it("the floor moves with buffer_minutes: with 30, a booking an hour away is the boundary", async () => {
    const { restaurantId, tableId, actor: who } = await restaurant({ rules: { ...rules, bufferMinutes: 30 } });
    await bookOn(restaurantId, tableId, 60, 120);

    expect(await seatWalkIn(who, tableId, 2, at(0.5))).toEqual({ outcome: "booking_soon", table: "T1", at: "20:00" });
    expect(await seatWalkIn(who, tableId, 2, NOW)).toMatchObject({ outcome: "seated" });
  });

  it("with no buffer the room is the whole gap", async () => {
    const { restaurantId, tableId, actor: who } = await restaurant({ rules: { ...rules, bufferMinutes: 0 } });
    await bookOn(restaurantId, tableId, 30, 90);

    expect(await seatWalkIn(who, tableId, 2, NOW)).toMatchObject({ outcome: "seated" });
    expect(iso((await walkInsOf(restaurantId))[0].holdEndsAt)).toBe(iso(at(30)));
  });

  it("the floor is on the room, not the sitting: a 20-minute sitting seats when nothing is booked", async () => {
    const { restaurantId, tableId, actor: who } = await restaurant({ rules: { ...rules, sittingMinutes: 20 } });

    expect(await seatWalkIn(who, tableId, 2, NOW)).toMatchObject({ outcome: "seated" });
    expect(iso((await walkInsOf(restaurantId))[0].endsAt)).toBe(iso(at(20)));
  });

  it("a booking whose buffer has already begun is refused, not given a backwards sitting", async () => {
    const { restaurantId, tableId, actor: who } = await restaurant();
    await bookOn(restaurantId, tableId, 10, 105);

    expect(await seatWalkIn(who, tableId, 2, NOW)).toMatchObject({ outcome: "booking_soon", at: "19:10" });
    expect(await walkInsOf(restaurantId)).toEqual([]);
  });

  it("only blocking statuses count as the next booking", async () => {
    const { restaurantId, tableId, actor: who } = await restaurant();
    await bookOn(restaurantId, tableId, 20, 105, { status: "cancelled" });
    await bookOn(restaurantId, tableId, 25, 105, { status: "no_show" });

    expect(await seatWalkIn(who, tableId, 2, NOW)).toMatchObject({ outcome: "seated" });
    expect(iso((await walkInsOf(restaurantId))[0].endsAt)).toBe(iso(at(90)));
  });

  it("a confirmed booking on another table is none of this table's business", async () => {
    const { restaurantId, tableIds, actor: who } = await restaurant({ tables: [{ capacity: 2 }, { capacity: 2 }] });
    await bookOn(restaurantId, tableIds[1], 20, 105);

    expect(await seatWalkIn(who, tableIds[0], 2, NOW)).toMatchObject({ outcome: "seated" });
  });

  it("the prompt names the time in the restaurant's zone, not the server's", async () => {
    const { restaurantId, tableId, actor: who } = await restaurant({ timezone: "Pacific/Auckland" });
    await bookOn(restaurantId, tableId, 20, 105);

    const result = await seatWalkIn(who, tableId, 2, NOW);

    // 17:20Z on 6 Nov is 06:20 on 7 Nov in Auckland (UTC+13).
    expect(result).toEqual({ outcome: "booking_soon", table: "T1", at: "06:20" });
    const response = walkInResponse(result, new Request("http://localhost/"));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe(
      "Table T1 has a booking at 06:20 — move that booking, or seat the walk-in elsewhere",
    );
  });
});

describe("a table that is occupied now", () => {
  it.each([
    ["a seated party", { status: "seated" as const }],
    ["a running-late confirmed booking", { status: "confirmed" as const }],
    ["the reset buffer after a finish", { status: "completed" as const }],
  ])("%s: refused with when it frees", async (_name, extra) => {
    const { restaurantId, tableId, actor: who } = await restaurant();
    await bookOn(restaurantId, tableId, -30, 105, extra);

    const result = await seatWalkIn(who, tableId, 2, NOW);

    expect(result).toEqual({ outcome: "table_occupied", table: "T1", freeAt: "20:15" });
    expect(await walkInsOf(restaurantId)).toEqual([]);
  });

  it("a booking whose hold ends exactly now doesn't hold the table", async () => {
    const { restaurantId, tableId, actor: who } = await restaurant();
    await bookOn(restaurantId, tableId, -105, 105, { status: "completed" });

    expect(await seatWalkIn(who, tableId, 2, NOW)).toMatchObject({ outcome: "seated" });
  });

  it("a no-show or cancelled booking from earlier doesn't hold it", async () => {
    const { restaurantId, tableId, actor: who } = await restaurant();
    await bookOn(restaurantId, tableId, -30, 105, { status: "no_show" });

    expect(await seatWalkIn(who, tableId, 2, NOW)).toMatchObject({ outcome: "seated" });
  });

  // Behaviour can't prove the starts_at lower bound in walk-in.ts exists (the unbounded
  // query gives the same answers, only slower; an EXPLAIN is the evidence, recorded in
  // the cycle report: with 30,000 earlier completed bookings on one table, the unbounded
  // busy query was a bitmap scan of 3041 buffers (14 ms); bounded, an index range scan on
  // (restaurant_id, starts_at) of 5 buffers (0.04 ms)). These pin the answers the bound must keep giving at the cap.
  it("a booking at the 960-minute cap that still holds the table counts as busy", async () => {
    const { restaurantId, tableId, actor: who } = await restaurant();
    await bookOn(restaurantId, tableId, -959, 960, { status: "seated" });

    expect(await seatWalkIn(who, tableId, 2, NOW)).toMatchObject({ outcome: "table_occupied" });
    expect(await walkInsOf(restaurantId)).toEqual([]);
  });

  it("a booking that finished long ago doesn't count, and one starting exactly 960 minutes back that has ended doesn't either", async () => {
    const { restaurantId, tableId, actor: who } = await restaurant();
    await bookOn(restaurantId, tableId, -5000, 120, { status: "completed" });
    await bookOn(restaurantId, tableId, -960, 960, { status: "seated" });

    expect(await seatWalkIn(who, tableId, 2, NOW)).toMatchObject({ outcome: "seated" });
  });

  it("a second walk-in on the same table is refused", async () => {
    const { tableId, actor: who } = await restaurant();
    await seatWalkIn(who, tableId, 2, NOW);

    expect(await seatWalkIn(who, tableId, 2, at(5))).toMatchObject({ outcome: "table_occupied", freeAt: "20:45" });
  });
});

describe("which tables, and which parties", () => {
  it("a walk-in-only table (bookable = false) takes a walk-in", async () => {
    const { tableId, actor: who } = await restaurant({ tables: [{ capacity: 2, bookable: false }, { capacity: 2 }] });

    expect(await seatWalkIn(who, tableId, 2, NOW)).toMatchObject({ outcome: "seated" });
  });

  it("an archived table is refused, and nothing is written", async () => {
    const { restaurantId, tableId, actor: who } = await restaurant({ tables: [{ capacity: 2 }, { capacity: 2 }] });
    await owner.db.update(diningTables).set({ archivedAt: new Date() }).where(eq(diningTables.id, tableId));

    expect(await seatWalkIn(who, tableId, 2, NOW)).toEqual({ outcome: "table_archived", table: "T1" });
    expect(await walkInsOf(restaurantId)).toEqual([]);
  });

  it("an archived table is refused by Postgres too, when the app's check is out of date", async () => {
    const { restaurantId, tableId } = await restaurant({ tables: [{ capacity: 2 }, { capacity: 2 }] });
    await owner.db.update(diningTables).set({ archivedAt: new Date() }).where(eq(diningTables.id, tableId));

    await expect(
      owner.db.insert(bookings).values({
        ...aBooking(restaurantId, tableId, iso(new Date()), iso(new Date(Date.now() + 3_600_000))),
        status: "seated",
        source: "staff",
      }),
    ).rejects.toMatchObject({ cause: { constraint: "bookings_table_live" } });
  });

  it("*(proposed)* a party above the table's capacity is seated: staff can see the room", async () => {
    const { restaurantId, tableId, actor: who } = await restaurant({ tables: [{ capacity: 2 }] });

    expect(await seatWalkIn(who, tableId, 4, NOW)).toMatchObject({ outcome: "seated" });
    expect((await walkInsOf(restaurantId))[0].partySize).toBe(4);
  });

  it("another restaurant's table, or one that doesn't exist, is not_found and writes nothing", async () => {
    const mine = await restaurant();
    const theirs = await restaurant();

    expect(await seatWalkIn(mine.actor, theirs.tableId, 2, NOW)).toEqual({ outcome: "not_found" });
    expect(await seatWalkIn(mine.actor, crypto.randomUUID(), 2, NOW)).toEqual({ outcome: "not_found" });
    expect(await walkInsOf(theirs.restaurantId)).toEqual([]);
    expect(await walkInsOf(mine.restaurantId)).toEqual([]);
  });

  it("lists the live tables, walk-in only ones included, and not an archived one", async () => {
    const { restaurantId, tableIds } = await restaurant({
      tables: [{ capacity: 2, label: "A" }, { capacity: 4, bookable: false, label: "B" }, { capacity: 2, label: "C" }],
    });
    await owner.db.update(diningTables).set({ archivedAt: new Date() }).where(eq(diningTables.id, tableIds[2]));

    const tables = await walkInTables({ restaurantId });

    expect(tables.map((t) => t.label)).toEqual(["A", "B"]);
  });
});

describe("audit", () => {
  it("a walk-in by staff isn't on spec 01's audit list, so nothing is written", async () => {
    const { restaurantId, tableId, actor: who } = await restaurant();

    await seatWalkIn(who, tableId, 2, NOW);

    expect(await owner.db.select().from(auditLog).where(eq(auditLog.restaurantId, restaurantId))).toEqual([]);
  });

  it("a platform admin inside the restaurant is audited, without the guest's details", async () => {
    const { restaurantId, tableId } = await restaurant();
    const platformAdminId = crypto.randomUUID(); // audit_log.actor_id has no foreign key

    await seatWalkIn({ restaurantId, staffId: crypto.randomUUID(), platformAdminId }, tableId, 2, NOW);

    const entries = await owner.db.select().from(auditLog).where(eq(auditLog.restaurantId, restaurantId));
    expect(entries).toEqual([
      expect.objectContaining({ action: "booking.walk_in", actorType: "platform_admin", actorId: platformAdminId }),
    ]);
  });
});

describe("online availability", () => {
  const guest = (time: string): GuestRequest => ({
    party: 2, date, time, name: "Online guest", phone: "+263771234567", note: null, whatsappOptIn: true,
  });
  // Early enough that the lead time and window aren't what's refusing anything.
  const asked = new Date("2026-11-06T10:00:00Z");
  const times = async (restaurantId: string) =>
    (await getBookingPage({ restaurantId }, { party: "2", date }, asked)).times?.map((t) => t.time);

  it("the table is gone for its sitting and its buffer, and back after", async () => {
    const { restaurantId, tableId, actor: who } = await restaurant({ tables: [{ capacity: 2 }] });
    expect(await times(restaurantId)).toEqual(["18:00", "18:30", "19:00", "19:30", "20:00", "20:30", "21:00"]);

    await seatWalkIn(who, tableId, 2, NOW);

    // Held 19:00 to 20:45 Harare. 18:00 and 18:30 would run into it (90 + 15 minutes), and so does 20:30.
    expect(await times(restaurantId)).toEqual(["21:00"]);
    expect((await confirmBooking({ restaurantId }, guest("19:30"), asked)).outcome).toBe("race_lost");
  });

  it("only the walk-in's table is lost: another table still sells the time", async () => {
    const { restaurantId, tableIds, actor: who } = await restaurant({ tables: [{ capacity: 2 }, { capacity: 2 }] });

    await seatWalkIn(who, tableIds[0], 2, NOW);

    expect(await times(restaurantId)).toContain("19:30");
    expect((await confirmBooking({ restaurantId }, guest("19:30"), asked)).outcome).toBe("confirmed");
  });
});

describe("finishing a walk-in", () => {
  it("works like any seated booking: completed, table freed after the buffer", async () => {
    const { finishBooking } = await import("./booking-day");
    const { restaurantId, tableId, actor: who } = await restaurant();
    const seated = await seatWalkIn(who, tableId, 2, NOW);
    if (seated.outcome !== "seated") throw new Error("not seated");

    expect(await finishBooking(who, seated.bookingId, at(40))).toEqual({ outcome: "done" });

    const [row] = await walkInsOf(restaurantId);
    expect(row.status).toBe("completed");
    expect([iso(row.endsAt), iso(row.holdEndsAt)]).toEqual([iso(at(40)), iso(at(55))]);
  });
});

// --- the race ---------------------------------------------------------------

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

describe("racing a guest's confirm", () => {
  it("a booking that lands inside the walk-in's hold at the same moment wins, and staff are told", async () => {
    const { restaurantId, tableId, actor: who } = await restaurant();
    const connection = await owner.pool.connect();
    try {
      await connection.query("begin");
      const { rows } = await connection.query("select pg_backend_pid() as pid");
      // Not committed, so the walk-in can't see it when it looks for the next booking.
      await connection.query(
        `insert into bookings (restaurant_id, table_id, guest_name, whatsapp_opt_in, party_size,
           starts_at, ends_at, hold_ends_at, status, source, manage_token)
         values ($1, $2, 'Landed', true, 2, $3, $4, $5, 'confirmed', 'online', $6)`,
        [restaurantId, tableId, iso(at(60)), iso(at(150)), iso(at(165)), crypto.randomUUID().replaceAll("-", "")],
      );
      const seating = seatWalkIn(who, tableId, 2, NOW);
      await blockedBehind(rows[0].pid);
      await connection.query("commit");

      expect(await seating).toEqual({ outcome: "table_taken" });
      expect(walkInResponse({ outcome: "table_taken" }, new Request("http://localhost/")).status).toBe(409);
    } finally {
      connection.release(true);
    }
    expect(await walkInsOf(restaurantId)).toEqual([]);
    expect(await bookingsOf(owner.db, restaurantId)).toHaveLength(1);
  });

  it("the reverse: the walk-in commits first, and the guest's insert is the one refused", async () => {
    const { restaurantId, tableId, actor: who } = await restaurant();
    await seatWalkIn(who, tableId, 2, NOW);

    await expect(
      owner.db.insert(bookings).values(aBooking(restaurantId, tableId, iso(at(60)), iso(at(165)))),
    ).rejects.toMatchObject({ cause: { code: "23P01", constraint: "bookings_no_overlap" } });
  });

  it.each([1, 2, 3, 4, 5])("a real confirm and a real walk-in together (round %i): one winner, no error", async () => {
    const { restaurantId, tableId, actor: who } = await restaurant({ tables: [{ capacity: 2 }] });
    const asked = new Date("2026-11-06T10:00:00Z");
    const request: GuestRequest = {
      party: 2, date, time: "19:30", name: "Online guest", phone: "+263771234567", note: null, whatsappOptIn: true,
    };

    const [walkIn, confirm] = await Promise.all([
      seatWalkIn(who, tableId, 2, NOW),
      confirmBooking({ restaurantId }, request, asked),
    ]);

    const all = await bookingsOf(owner.db, restaurantId);
    expect(all).toHaveLength(1);
    expect([walkIn.outcome === "seated", confirm.outcome === "confirmed"].filter(Boolean)).toHaveLength(1);
    if (walkIn.outcome !== "seated") {
      expect(["booking_soon", "table_taken"]).toContain(walkIn.outcome);
    }
  });

  it.each([1, 2, 3, 4, 5])("a staff add and a walk-in together (round %i): one winner, a clear answer, no error", async () => {
    const { restaurantId, tableId, actor: who } = await restaurant({ tables: [{ capacity: 2 }] });
    const staffAdd = {
      party: 2, date, time: "19:30", tableId, name: "Phone guest", phone: null, note: null, whatsappOptIn: false,
    };

    const [walkIn, added] = await Promise.all([
      seatWalkIn(who, tableId, 2, NOW),
      addStaffBooking(who, staffAdd, new Date("2026-11-06T10:00:00Z")),
    ]);

    expect(await bookingsOf(owner.db, restaurantId)).toHaveLength(1);
    expect([walkIn.outcome === "seated", added.outcome === "added"].filter(Boolean)).toHaveLength(1);
    if (walkIn.outcome !== "seated") expect(["booking_soon", "table_taken"]).toContain(walkIn.outcome);
    if (added.outcome !== "added") expect(added).toEqual({ outcome: "taken" });
  });

  it("two walk-ins together: one is seated, the other told the table is taken", async () => {
    const { restaurantId, tableId, actor: who } = await restaurant();

    const results = await Promise.all([seatWalkIn(who, tableId, 2, NOW), seatWalkIn(who, tableId, 3, NOW)]);

    expect(results.filter((r) => r.outcome === "seated")).toHaveLength(1);
    expect(results.find((r) => r.outcome !== "seated")?.outcome).toBe("table_taken");
    expect(await walkInsOf(restaurantId)).toHaveLength(1);
  });
});
