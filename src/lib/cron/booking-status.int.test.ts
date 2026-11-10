import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { auditLog, bookings } from "@/db/schema";
import { aBooking, bookableRestaurant } from "../../../test/integration/bookings";
import { openOwnerDatabase, openSystemDatabase } from "../../../test/integration/database";
import { completeOverdueSittings, markNoShows } from "./booking-status";

/**
 * Spec 04's automatic status changes, run by the scheduled job as app_system
 * (S-35). The job works across every restaurant, so these tests live in 1990:
 * the job is handed a 1990 "now", and no other test's booking ends that early,
 * so running it here can't change a booking another test file is looking at.
 */
const owner = openOwnerDatabase();
const system = openSystemDatabase();
afterAll(() => Promise.all([owner.pool.end(), system.pool.end()]));

const NOW = new Date("1990-06-01T18:00:00Z");
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

async function restaurant(tables = 1) {
  return bookableRestaurant(owner.db, {
    tables: Array.from({ length: tables }, () => ({ capacity: 4 })),
    rules: { bufferMinutes: 15 },
  });
}

/** A booking starting `start` minutes from NOW, ending at `end`, held to `hold`. */
async function aBookingAt(
  restaurantId: string,
  tableId: string,
  { start, end, hold = end, status }: { start: number; end: number; hold?: number; status: typeof bookings.$inferSelect["status"] },
) {
  const [row] = await owner.db
    .insert(bookings)
    .values({
      ...aBooking(restaurantId, tableId, minutes(start).toISOString(), minutes(hold).toISOString()),
      endsAt: minutes(end),
      status,
    })
    .returning({ id: bookings.id });
  return row.id;
}

const bookingRow = async (id: string) => {
  const [row] = await owner.db
    .select({ status: bookings.status, endsAt: bookings.endsAt, holdEndsAt: bookings.holdEndsAt })
    .from(bookings)
    .where(eq(bookings.id, id));
  return row;
};

const auditOf = (id: string) =>
  owner.db
    .select({
      restaurantId: auditLog.restaurantId,
      actorType: auditLog.actorType,
      actorId: auditLog.actorId,
      action: auditLog.action,
      entityType: auditLog.entityType,
      details: auditLog.details,
    })
    .from(auditLog)
    .where(eq(auditLog.entityId, id));

describe("a confirmed booking nobody seated", () => {
  it("becomes a no-show once its sitting has ended, recorded as the system's doing", async () => {
    const { restaurantId, tableIds } = await restaurant();
    const id = await aBookingAt(restaurantId, tableIds[0], { start: -120, end: -30, hold: -15, status: "confirmed" });

    expect(await markNoShows(system.db, NOW)).toBeGreaterThanOrEqual(1);

    expect((await bookingRow(id)).status).toBe("no_show");
    expect(await auditOf(id)).toEqual([
      {
        restaurantId,
        actorType: "system",
        actorId: null,
        action: "booking.no_show",
        entityType: "booking",
        details: {},
      },
    ]);
  });

  it("becomes a no-show at the very minute its sitting ends", async () => {
    const { restaurantId, tableIds } = await restaurant();
    const id = await aBookingAt(restaurantId, tableIds[0], { start: -90, end: 0, hold: 15, status: "confirmed" });
    await markNoShows(system.db, NOW);
    expect((await bookingRow(id)).status).toBe("no_show");
  });

  it("is only Late while its sitting runs: nothing automatic happens to it, staff decide", async () => {
    const { restaurantId, tableIds } = await restaurant();
    // 45 minutes past its start, so the day view shows it as Late, with 45 to go.
    const id = await aBookingAt(restaurantId, tableIds[0], { start: -45, end: 45, hold: 60, status: "confirmed" });
    await markNoShows(system.db, NOW);
    expect(await bookingRow(id)).toMatchObject({ status: "confirmed", endsAt: minutes(45) });
    expect(await auditOf(id)).toEqual([]);
  });

  it("leaves bookings already seated, cancelled, completed or a no-show alone", async () => {
    const { restaurantId, tableIds } = await restaurant(4);
    const statuses = ["seated", "cancelled", "completed", "no_show"] as const;
    const ids = await Promise.all(
      statuses.map((status, i) =>
        aBookingAt(restaurantId, tableIds[i], { start: -120, end: -30, hold: 30, status }),
      ),
    );
    await markNoShows(system.db, NOW);
    expect(await Promise.all(ids.map(async (id) => (await bookingRow(id)).status))).toEqual(statuses);
    for (const id of ids) expect(await auditOf(id)).toEqual([]);
  });

  it("is marked once however many runs arrive, together or one after another", async () => {
    const { restaurantId, tableIds } = await restaurant(3);
    const ids = await Promise.all(
      tableIds.map((tableId) => aBookingAt(restaurantId, tableId, { start: -120, end: -30, status: "confirmed" })),
    );
    // Vercel can deliver one run twice, and a slow run can overlap the next.
    await Promise.all([markNoShows(system.db, NOW), markNoShows(system.db, NOW), markNoShows(system.db, NOW)]);
    await markNoShows(system.db, NOW);
    for (const id of ids) {
      expect((await bookingRow(id)).status).toBe("no_show");
      expect(await auditOf(id)).toHaveLength(1);
    }
  });
});

describe("a seated party past its hold", () => {
  it("is completed, with the times staff's Finish would give it now, recorded as the system's doing", async () => {
    const { restaurantId, tableIds } = await restaurant();
    const id = await aBookingAt(restaurantId, tableIds[0], { start: -120, end: -30, hold: -15, status: "seated" });

    expect(await completeOverdueSittings(system.db, NOW)).toBeGreaterThanOrEqual(1);

    // ends_at = now, hold_ends_at = now + the 15-minute buffer.
    expect(await bookingRow(id)).toEqual({ status: "completed", endsAt: NOW, holdEndsAt: minutes(15) });
    expect(await auditOf(id)).toEqual([
      {
        restaurantId,
        actorType: "system",
        actorId: null,
        action: "booking.complete",
        entityType: "booking",
        details: {},
      },
    ]);
  });

  it("is left alone until its hold has ended", async () => {
    const { restaurantId, tableIds } = await restaurant();
    const id = await aBookingAt(restaurantId, tableIds[0], { start: -90, end: -5, hold: 10, status: "seated" });
    await completeOverdueSittings(system.db, NOW);
    expect(await bookingRow(id)).toEqual({ status: "seated", endsAt: minutes(-5), holdEndsAt: minutes(10) });
    expect(await auditOf(id)).toEqual([]);
  });

  it("stops its hold at the next booking on that table", async () => {
    const { restaurantId, tableIds } = await restaurant();
    const id = await aBookingAt(restaurantId, tableIds[0], { start: -120, end: -30, hold: -15, status: "seated" });
    await aBookingAt(restaurantId, tableIds[0], { start: 5, end: 95, hold: 110, status: "confirmed" });
    await completeOverdueSittings(system.db, NOW);
    expect(await bookingRow(id)).toEqual({ status: "completed", endsAt: NOW, holdEndsAt: minutes(5) });
  });

  it("keeps hold_ends_at within 960 minutes of the start however late the job is", async () => {
    const { restaurantId, tableIds } = await restaurant();
    const id = await aBookingAt(restaurantId, tableIds[0], { start: -1000, end: -60, hold: -45, status: "seated" });
    await completeOverdueSittings(system.db, NOW);
    // The buffer gives way first, then ends_at: both stop at start + 960.
    expect(await bookingRow(id)).toEqual({ status: "completed", endsAt: minutes(-40), holdEndsAt: minutes(-40) });
  });

  it("leaves confirmed, cancelled, completed and no-show bookings alone", async () => {
    const { restaurantId, tableIds } = await restaurant(4);
    const statuses = ["confirmed", "cancelled", "completed", "no_show"] as const;
    const ids = await Promise.all(
      statuses.map((status, i) =>
        aBookingAt(restaurantId, tableIds[i], { start: -120, end: -30, hold: -15, status }),
      ),
    );
    await completeOverdueSittings(system.db, NOW);
    for (const [i, id] of ids.entries()) {
      expect(await bookingRow(id)).toEqual({ status: statuses[i], endsAt: minutes(-30), holdEndsAt: minutes(-15) });
    }
  });

  it("is completed once however many runs arrive, together or one after another", async () => {
    const { restaurantId, tableIds } = await restaurant(3);
    const ids = await Promise.all(
      tableIds.map((tableId) => aBookingAt(restaurantId, tableId, { start: -120, end: -30, hold: -15, status: "seated" })),
    );
    await Promise.all([
      completeOverdueSittings(system.db, NOW),
      completeOverdueSittings(system.db, NOW),
      completeOverdueSittings(system.db, NOW),
    ]);
    // A later run must not move the times again.
    await completeOverdueSittings(system.db, minutes(5));
    for (const id of ids) {
      expect(await bookingRow(id)).toEqual({ status: "completed", endsAt: NOW, holdEndsAt: minutes(15) });
      expect(await auditOf(id)).toHaveLength(1);
    }
  });
});

describe("the job and staff acting at the same moment", () => {
  /** A connection with its own transaction open, as staff's request would hold one. */
  async function aStaffTransaction() {
    const client = await owner.pool.connect();
    await client.query("begin");
    return client;
  }

  it("skips a booking staff are changing rather than waiting, and the next run takes it", async () => {
    const { restaurantId, tableIds } = await restaurant(2);
    const noShow = await aBookingAt(restaurantId, tableIds[0], { start: -120, end: -30, status: "confirmed" });
    const overdue = await aBookingAt(restaurantId, tableIds[1], { start: -120, end: -30, hold: -15, status: "seated" });
    const staff = await aStaffTransaction();
    try {
      await staff.query("select id from bookings where id = any($1) for update", [[noShow, overdue]]);
      await markNoShows(system.db, NOW);
      await completeOverdueSittings(system.db, NOW);
      expect((await bookingRow(noShow)).status).toBe("confirmed");
      expect((await bookingRow(overdue)).status).toBe("seated");
    } finally {
      await staff.query("rollback");
      staff.release();
    }
    await markNoShows(system.db, NOW);
    await completeOverdueSittings(system.db, NOW);
    expect((await bookingRow(noShow)).status).toBe("no_show");
    expect((await bookingRow(overdue)).status).toBe("completed");
  });

  it("loses to staff who got there first, and records nothing", async () => {
    const { restaurantId, tableIds } = await restaurant();
    const id = await aBookingAt(restaurantId, tableIds[0], { start: -120, end: -30, status: "confirmed" });
    const staff = await aStaffTransaction();
    try {
      // Staff seat the party late; the job's run starts before they commit.
      await staff.query("update bookings set status = 'seated' where id = $1", [id]);
      const run = markNoShows(system.db, NOW);
      await staff.query("commit");
      await run;
    } finally {
      staff.release();
    }
    await markNoShows(system.db, NOW);
    expect((await bookingRow(id)).status).toBe("seated");
    expect(await auditOf(id)).toEqual([]);
  });

  it("leaves a party seated when a booking lands in its stretched hold at that instant, and finishes it next run", async () => {
    const { restaurantId, tableIds } = await restaurant(2);
    const id = await aBookingAt(restaurantId, tableIds[0], { start: -120, end: -30, hold: -15, status: "seated" });
    // Another overdue party on another table, which the refusal mustn't cost.
    const other = await aBookingAt(restaurantId, tableIds[1], { start: -120, end: -30, hold: -15, status: "seated" });
    const guest = await aStaffTransaction();
    try {
      // A booking from 18:05 on the same table, not yet committed: the job's
      // hold (to 18:15) can't see it, so the exclusion constraint waits on it.
      await guest.query(
        `insert into bookings (restaurant_id, table_id, guest_name, whatsapp_opt_in, party_size,
           starts_at, ends_at, hold_ends_at, status, source, manage_token)
         values ($1, $2, 'Arriving', false, 2, $3, $4, $4, 'confirmed', 'staff', $5)`,
        [restaurantId, tableIds[0], minutes(5), minutes(95), crypto.randomUUID().replaceAll("-", "")],
      );
      const run = completeOverdueSittings(system.db, NOW);
      await vi.waitFor(
        async () => {
          const { rows } = await owner.db.execute<{ waiting: number }>(sql`
            select count(*)::int as waiting from pg_stat_activity
            where usename = 'app_system' and wait_event_type = 'Lock'`);
          expect(rows[0].waiting).toBeGreaterThan(0);
        },
        { timeout: 5_000, interval: 20 },
      );
      await guest.query("commit");
      await run;
    } finally {
      guest.release();
    }
    expect((await bookingRow(id)).status).toBe("seated");
    expect(await auditOf(id)).toEqual([]);
    expect((await bookingRow(other)).status).toBe("completed");

    await completeOverdueSittings(system.db, NOW);
    expect(await bookingRow(id)).toEqual({ status: "completed", endsAt: NOW, holdEndsAt: minutes(5) });
  });
});
