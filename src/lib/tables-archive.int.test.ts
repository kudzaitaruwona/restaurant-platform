import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bookings, diningTables } from "@/db/schema";
import { addDays, localToday } from "@/lib/booking-engine";
import { aBooking, bookableRestaurant, bookingsOf } from "../../test/integration/bookings";
import { openOwnerDatabase, testDatabaseSettings } from "../../test/integration/database";
import { confirmBooking, type GuestRequest } from "./bookings";
import { archiveTable } from "./tables";

/**
 * The real confirm and the real archive, started together, over and over. The
 * deterministic orderings are in src/db/table-archive-guard.int.test.ts, each
 * waiting on the blocked backend; this is the app on top of them.
 */
vi.mock("next/cache", () => ({ revalidateTag: () => {} }));

const owner = openOwnerDatabase();
beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});
afterAll(async () => {
  await owner.pool.end();
  vi.unstubAllEnvs();
});

const now = new Date();
const guest = (): GuestRequest => ({
  party: 2,
  date: addDays(localToday(now, "Africa/Harare"), 1),
  time: "19:00",
  name: "Tariro",
  phone: "+263771234567",
  note: null,
  whatsappOptIn: true,
});

describe("a confirm and an archive started together", () => {
  it.each(Array.from({ length: 12 }, (_, round) => round))(
    "round %i: never leaves a future booking on an archived table, and neither call fails",
    async () => {
      const { restaurantId, tableIds: [tableId] } = await bookableRestaurant(owner.db);
      const tenant = { restaurantId, staffId: crypto.randomUUID(), platformAdminId: undefined };

      const [confirmation, archived] = await Promise.all([
        confirmBooking({ restaurantId }, guest(), now),
        archiveTable(tenant as never, tableId),
      ]);

      const [table] = await owner.db.select().from(diningTables).where(eq(diningTables.id, tableId));
      const rows = await bookingsOf(owner.db, restaurantId);
      if (table.archivedAt) {
        expect(archived).toBe("saved");
        expect(rows).toEqual([]);
        expect(confirmation.outcome).not.toBe("confirmed");
      } else {
        expect(archived).toMatchObject({ blocked: { bookings: [{ guestName: "Tariro" }] } });
        expect(confirmation.outcome).toBe("confirmed");
        expect(rows).toHaveLength(1);
      }
      const { rows: bad } = await owner.db.execute(sql`
        select 1 from bookings b join tables t on t.id = b.table_id
        where b.restaurant_id = ${restaurantId} and t.archived_at is not null
          and b.status in ('confirmed','seated') and b.hold_ends_at > now()
      `);
      expect(bad).toEqual([]);
    },
  );
});

describe("the bookings an archive lists", () => {
  // The list reads back only as far as bookings_hold_capped allows, like the guard.
  it("reaches back to the longest hold there can be", async () => {
    const { restaurantId, tableIds: [tableId] } = await bookableRestaurant(owner.db);
    const holdEnds = Date.now() + 2 * 60_000;
    await owner.db.insert(bookings).values({
      ...aBooking(
        restaurantId,
        tableId,
        new Date(holdEnds - 960 * 60_000).toISOString(),
        new Date(holdEnds).toISOString(),
      ),
      status: "seated",
    });
    const tenant = { restaurantId, staffId: crypto.randomUUID(), platformAdminId: undefined };

    expect(await archiveTable(tenant as never, tableId)).toMatchObject({
      blocked: { bookings: [{ status: "seated" }] },
    });
  });
});

describe("a confirm that loses to an archive already in flight", () => {
  it("gets the lost-race answer, not an error, and books nothing", async () => {
    const { restaurantId, tableIds: [tableId] } = await bookableRestaurant(owner.db);
    const archiver = await owner.pool.connect();
    try {
      await archiver.query("begin");
      await archiver.query("update tables set archived_at = now() where id = $1", [tableId]);
      const { rows: [{ pid }] } = await archiver.query("select pg_backend_pid() as pid");

      const confirming = confirmBooking({ restaurantId }, guest(), now);
      // Waits on the archive's lock, not just on any lock.
      await vi.waitFor(
        async () => {
          const { rows } = await owner.db.execute(sql`
            select 1 from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid)) limit 1
          `);
          expect(rows.length).toBe(1);
        },
        { timeout: 5_000, interval: 20 },
      );
      await archiver.query("commit");

      expect((await confirming).outcome).toBe("race_lost");
      expect(await bookingsOf(owner.db, restaurantId)).toEqual([]);
    } finally {
      archiver.release(true);
    }
  });
});
