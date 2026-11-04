import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  aBooking,
  asTenant,
  bookableRestaurant,
  bookingsOf,
} from "../../test/integration/bookings";
import { openOwnerDatabase, openTestDatabase } from "../../test/integration/database";
import { bookings } from "./schema";

/**
 * The per-phone limit is a trigger (migration 0024), because counting first and
 * inserting after is a race. Rows go straight at Postgres as app_tenant.
 */
const app = openTestDatabase();
const owner = openOwnerDatabase();
afterAll(() => Promise.all([app.pool.end(), owner.pool.end()]));

const PHONE = "+263771110000";
const LIMIT = { cause: { code: "23514", constraint: "bookings_max_active_per_phone" } };
const HOUR = 3_600_000;
/** Real-clock future: the trigger counts from the database's now(). */
const at = (days: number, hour = 0) => {
  const start = new Date(Date.now() + days * 24 * HOUR + hour * HOUR);
  return [start.toISOString(), new Date(start.getTime() + HOUR).toISOString()] as const;
};
const row = (restaurantId: string, tableId: string, days: number, extra: Partial<typeof bookings.$inferInsert> = {}) => {
  const [start, end] = at(days);
  return { ...aBooking(restaurantId, tableId, start, end), guestPhone: PHONE, ...extra };
};
const insert = (value: typeof bookings.$inferInsert) =>
  asTenant(app.db, value.restaurantId, (tx) => tx.insert(bookings).values(value));

const restaurant = (limit = 2) =>
  bookableRestaurant(owner.db, {
    tables: [{ capacity: 2 }, { capacity: 2 }, { capacity: 2 }],
    rules: { maxActiveBookingsPerPhone: limit },
  });

describe("the per-phone trigger", () => {
  it("refuses one past the limit, naming the rule, and writes nothing", async () => {
    const { restaurantId, tableIds } = await restaurant();
    await insert(row(restaurantId, tableIds[0], 2));
    await insert(row(restaurantId, tableIds[0], 3));

    await expect(insert(row(restaurantId, tableIds[0], 4))).rejects.toMatchObject(LIMIT);
    expect(await bookingsOf(owner.db, restaurantId)).toHaveLength(2);
  });

  it("doesn't count cancelled, no-show, completed, seated or past bookings", async () => {
    const { restaurantId, tableIds } = await restaurant(1);
    for (const [index, status] of (["cancelled", "no_show", "completed", "seated"] as const).entries()) {
      await owner.db.insert(bookings).values(row(restaurantId, tableIds[0], 2 + index, { status }));
    }
    await owner.db.insert(bookings).values(row(restaurantId, tableIds[0], -3));

    await expect(insert(row(restaurantId, tableIds[0], 10))).resolves.toBeDefined();
  });

  it("counts per phone and per restaurant", async () => {
    const one = await restaurant(1);
    const two = await restaurant(1);
    await insert(row(one.restaurantId, one.tableIds[0], 2));

    await expect(insert(row(one.restaurantId, one.tableIds[0], 3, { guestPhone: "+263771110001" }))).resolves.toBeDefined();
    await expect(insert(row(two.restaurantId, two.tableIds[0], 2))).resolves.toBeDefined();
  });

  it("applies to online bookings only, and counts a staff booking toward them", async () => {
    const { restaurantId, tableIds } = await restaurant(1);
    await owner.db.insert(bookings).values(row(restaurantId, tableIds[0], 2, { source: "staff" }));
    await expect(insert(row(restaurantId, tableIds[0], 3, { source: "staff" }))).resolves.toBeDefined();
    await expect(insert(row(restaurantId, tableIds[0], 4))).rejects.toMatchObject(LIMIT);
    await expect(insert(row(restaurantId, tableIds[0], 4, { guestPhone: null }))).resolves.toBeDefined();
  });

  it("follows the restaurant's setting", async () => {
    const { restaurantId, tableIds } = await restaurant(3);
    for (const day of [2, 3, 4]) await insert(row(restaurantId, tableIds[0], day));
    await expect(insert(row(restaurantId, tableIds[0], 5))).rejects.toMatchObject(LIMIT);
  });
});

describe("two confirms for one phone at once", () => {
  const pidOf = async (client: { query: (text: string) => Promise<{ rows: { pid: number }[] }> }) =>
    (await client.query("select pg_backend_pid() as pid")).rows[0].pid;

  /** This backend is waiting, and on that holder specifically. */
  const waitUntilBlockedBehind = (pid: number, holder: number) =>
    vi.waitFor(
      async () => {
        const { rows } = await owner.db.execute<{ wait: string; holders: number[] }>(sql`
          select wait_event_type as wait, pg_blocking_pids(pid) as holders
          from pg_stat_activity where pid = ${pid}
        `);
        expect(rows[0].wait).toBe("Lock");
        expect(rows[0].holders).toContain(holder);
      },
      { timeout: 5_000, interval: 20 },
    );

  const sqlFor = (value: ReturnType<typeof row>) => `
    insert into bookings (restaurant_id, table_id, guest_name, guest_phone, whatsapp_opt_in, party_size,
      starts_at, ends_at, hold_ends_at, status, source, manage_token)
    values ('${value.restaurantId}', '${value.tableId}', 'Guest', '${PHONE}', true, 2,
      '${value.startsAt.toISOString()}', '${value.endsAt.toISOString()}', '${value.holdEndsAt.toISOString()}',
      'confirmed', 'online', '${crypto.randomUUID().replaceAll("-", "")}')`;

  async function race(finish: "commit" | "rollback") {
    const { restaurantId, tableIds } = await restaurant(1);
    // Different tables and times: only the phone ties them together.
    const first = sqlFor(row(restaurantId, tableIds[0], 2));
    const second = sqlFor(row(restaurantId, tableIds[1], 3));
    const [one, two] = [await app.pool.connect(), await app.pool.connect()];
    try {
      for (const client of [one, two]) {
        await client.query("begin");
        await client.query(`select set_config('app.restaurant_id', '${restaurantId}', true)`);
      }
      await one.query(first);
      const pid = await pidOf(two);
      const racing = two.query(second).then(
        () => "passed",
        (error: { constraint?: string }) => error.constraint ?? "failed",
      );
      await waitUntilBlockedBehind(pid, await pidOf(one));
      await one.query(finish);
      const outcome = await racing;
      await two.query(outcome === "passed" ? "commit" : "rollback");
      return { outcome, rows: await bookingsOf(owner.db, restaurantId) };
    } finally {
      one.release(true);
      two.release(true);
    }
  }

  it("the second waits for the first, then is refused when the first commits", async () => {
    const { outcome, rows } = await race("commit");
    expect(outcome).toBe("bookings_max_active_per_phone");
    expect(rows).toHaveLength(1);
  });

  it("the second gets the last place when the first rolls back", async () => {
    const { outcome, rows } = await race("rollback");
    expect(outcome).toBe("passed");
    expect(rows).toHaveLength(1);
  });
});

describe("the trigger", () => {
  it("is on bookings, after insert, for online bookings", async () => {
    const { rows } = await owner.db.execute<{ def: string }>(sql`
      select pg_get_triggerdef(oid) as def from pg_trigger
      where tgname = 'bookings_max_active_per_phone' and not tgisinternal`);
    expect(rows).toHaveLength(1);
    expect(rows[0].def).toContain("AFTER INSERT ON public.bookings");
    expect(rows[0].def).toContain("online");
  });
});
