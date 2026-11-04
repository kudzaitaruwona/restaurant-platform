import { eq, sql } from "drizzle-orm";
import type { PoolClient } from "@neondatabase/serverless";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  aBooking,
  asTenant,
  bookableRestaurant,
  bookingsOf,
} from "../../test/integration/bookings";
import { openOwnerDatabase, openTestDatabase } from "../../test/integration/database";
import { bookings, closures } from "./schema";

/**
 * Closures (spec 04, migration 0019): written straight at Postgres, as app_tenant
 * where the app would be, with none of the app's own checks in the way. The
 * guards: a closure can't be saved over a confirmed booking, and a confirmed
 * booking can't be made inside a closure, whichever commits first.
 */
const app = openTestDatabase();
const owner = openOwnerDatabase();
afterAll(() => Promise.all([app.pool.end(), owner.pool.end()]));

const MINUTE = 60_000;
const HOUR = 3_600_000;
// One base for the whole file, so two offsets that are meant to be equal are.
const BASE = Date.now();
const at = (hours: number) => new Date(BASE + hours * HOUR);

const COVER = { cause: { code: "23514", constraint: "closures_cover_bookings" } };
const INSIDE = { cause: { code: "23514", constraint: "bookings_within_closure" } };

/** A booking whose sitting runs from `from` to `to` hours from now, hold ending with it. */
const booking = (restaurantId: string, tableId: string, from: number, to: number) =>
  aBooking(restaurantId, tableId, at(from).toISOString(), at(to).toISOString());

const insertBooking = (row: typeof bookings.$inferInsert) =>
  asTenant(app.db, row.restaurantId, (tx) => tx.insert(bookings).values(row));

const insertClosure = (restaurantId: string, from: number, to: number, reason: string | null = null) =>
  asTenant(app.db, restaurantId, (tx) =>
    tx.insert(closures).values({ restaurantId, startsAt: at(from), endsAt: at(to), reason }),
  );

const closuresOf = (restaurantId: string) =>
  owner.db.select().from(closures).where(eq(closures.restaurantId, restaurantId));

describe("the closures table", () => {
  it("refuses a closure that doesn't end after it starts", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db);

    await expect(insertClosure(restaurantId, 5, 5)).rejects.toMatchObject({
      cause: { code: "23514", constraint: "closures_times_ordered" },
    });
    await expect(insertClosure(restaurantId, 6, 5)).rejects.toMatchObject({
      cause: { code: "23514", constraint: "closures_times_ordered" },
    });
    expect(await closuresOf(restaurantId)).toEqual([]);
  });

  it("bounds the reason: blank or over 200 characters is refused, none is fine", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db);

    await expect(insertClosure(restaurantId, 5, 6, "   ")).rejects.toMatchObject({
      cause: { constraint: "closures_reason" },
    });
    await expect(insertClosure(restaurantId, 5, 6, "x".repeat(201))).rejects.toMatchObject({
      cause: { constraint: "closures_reason" },
    });
    await insertClosure(restaurantId, 5, 6, "x".repeat(200));
    await insertClosure(restaurantId, 7, 8, null);
    expect(await closuresOf(restaurantId)).toHaveLength(2);
  });

  it("is invisible across restaurants, and a forged restaurant id is refused", async () => {
    const a = await bookableRestaurant(owner.db);
    const b = await bookableRestaurant(owner.db);
    await insertClosure(b.restaurantId, 5, 6);

    const seenByA = await asTenant(app.db, a.restaurantId, (tx) =>
      tx.select().from(closures).where(eq(closures.restaurantId, b.restaurantId)),
    );
    const forged = await insertClosure(b.restaurantId, 7, 8).then(
      () => "passed" as const,
      (error: unknown) => error,
    );
    const aToB = await asTenant(app.db, a.restaurantId, (tx) =>
      tx.insert(closures).values({ restaurantId: b.restaurantId, startsAt: at(9), endsAt: at(10) }),
    ).catch((error: unknown) => error);

    expect(seenByA).toEqual([]);
    expect(forged).toBe("passed"); // B's own context may, of course
    expect(aToB).toMatchObject({ cause: { code: "42501" } });
    expect(await closuresOf(b.restaurantId)).toHaveLength(2);
  });

  it("has the composite key a tenant table has", async () => {
    const { rows } = await owner.db.execute<{ definition: string }>(sql`
      select pg_get_constraintdef(oid) as definition from pg_constraint
      where conrelid = 'closures'::regclass and contype in ('u', 'f')`);
    const definitions = rows.map(({ definition }) => definition);

    expect(definitions).toContain("UNIQUE (restaurant_id, id)");
    expect(definitions.some((text) => text.startsWith("FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)"))).toBe(
      true,
    );
  });
});

describe("saving a closure over bookings", () => {
  it("is refused while a confirmed booking's sitting runs into it, and nothing is saved", async () => {
    const { restaurantId, tableIds: [tableId] } = await bookableRestaurant(owner.db);
    await insertBooking(booking(restaurantId, tableId, 24, 25.5));

    await expect(insertClosure(restaurantId, 24.5, 30)).rejects.toMatchObject(COVER);
    await expect(insertClosure(restaurantId, 20, 24.1)).rejects.toMatchObject(COVER);
    await expect(insertClosure(restaurantId, 20, 30)).rejects.toMatchObject(COVER);
    await expect(insertClosure(restaurantId, 24.2, 24.4)).rejects.toMatchObject(COVER);

    expect(await closuresOf(restaurantId)).toEqual([]);
  });

  it("is allowed when the sitting only touches it: the ranges are half-open", async () => {
    const { restaurantId, tableIds: [tableId] } = await bookableRestaurant(owner.db);
    await insertBooking(booking(restaurantId, tableId, 24, 25.5));

    await insertClosure(restaurantId, 25.5, 30);
    await insertClosure(restaurantId, 20, 24);

    expect(await closuresOf(restaurantId)).toHaveLength(2);
  });

  // *(Proposed)* the sitting counts, not the hold: the buffer is the restaurant's own reset time.
  it("doesn't count the reset buffer: a hold that runs into it but a sitting that doesn't is allowed", async () => {
    const { restaurantId, tableIds: [tableId] } = await bookableRestaurant(owner.db);
    await insertBooking({ ...booking(restaurantId, tableId, 24, 26), endsAt: at(25.5) });

    await insertClosure(restaurantId, 25.5, 30);

    expect(await closuresOf(restaurantId)).toHaveLength(1);
  });

  it.each(["seated", "completed", "cancelled", "no_show"] as const)(
    "is allowed over a %s booking: only a confirmed one is in the way",
    async (status) => {
      const { restaurantId, tableIds: [tableId] } = await bookableRestaurant(owner.db);
      await insertBooking({ ...booking(restaurantId, tableId, 1, 2), status });

      await insertClosure(restaurantId, 0, 5);

      expect(await closuresOf(restaurantId)).toHaveLength(1);
    },
  );

  it("counts a confirmed booking that has started but whose sitting hasn't ended (a guest running late)", async () => {
    const { restaurantId, tableIds: [tableId] } = await bookableRestaurant(owner.db);
    await insertBooking(booking(restaurantId, tableId, -0.5, 1));

    await expect(insertClosure(restaurantId, -2, 5)).rejects.toMatchObject(COVER);
  });

  it("ignores a booking whose sitting is over, even inside the closure's range", async () => {
    const { restaurantId, tableIds: [tableId] } = await bookableRestaurant(owner.db);
    await insertBooking(booking(restaurantId, tableId, -5, -3));

    await insertClosure(restaurantId, -6, 5);

    expect(await closuresOf(restaurantId)).toHaveLength(1);
  });

  // The guard reads back only as far as bookings_hold_capped allows, so this is the
  // oldest booking that can still be in the way: lowering the bound would miss it.
  it("reaches back to the longest sitting there can be", async () => {
    const { restaurantId, tableIds: [tableId] } = await bookableRestaurant(owner.db);
    const closureStart = Date.now() + 10 * MINUTE;
    const sittingEnds = closureStart + 2 * MINUTE;
    await insertBooking(
      aBooking(
        restaurantId,
        tableId,
        new Date(sittingEnds - 960 * MINUTE).toISOString(),
        new Date(sittingEnds).toISOString(),
      ),
    );

    await expect(
      asTenant(app.db, restaurantId, (tx) =>
        tx.insert(closures).values({
          restaurantId,
          startsAt: new Date(closureStart),
          endsAt: new Date(closureStart + HOUR),
        }),
      ),
    ).rejects.toMatchObject(COVER);
  });

  it("only looks at its own restaurant's bookings", async () => {
    const mine = await bookableRestaurant(owner.db);
    const other = await bookableRestaurant(owner.db);
    await insertBooking(booking(other.restaurantId, other.tableIds[0], 24, 25));

    await insertClosure(mine.restaurantId, 23, 26);

    expect(await closuresOf(mine.restaurantId)).toHaveLength(1);
  });

  it("is judged again when a closure is moved over a booking", async () => {
    const { restaurantId, tableIds: [tableId] } = await bookableRestaurant(owner.db);
    await insertBooking(booking(restaurantId, tableId, 24, 25));
    await insertClosure(restaurantId, 40, 41);

    await expect(
      asTenant(app.db, restaurantId, (tx) =>
        tx.update(closures).set({ startsAt: at(23), endsAt: at(26) }).where(eq(closures.restaurantId, restaurantId)),
      ),
    ).rejects.toMatchObject(COVER);
  });

  it("is allowed once the booking is cancelled", async () => {
    const { restaurantId, tableIds: [tableId] } = await bookableRestaurant(owner.db);
    const row = booking(restaurantId, tableId, 24, 25);
    await insertBooking(row);
    await expect(insertClosure(restaurantId, 23, 26)).rejects.toMatchObject(COVER);

    await owner.db
      .update(bookings)
      .set({ status: "cancelled" })
      .where(eq(bookings.manageToken, row.manageToken));
    await insertClosure(restaurantId, 23, 26);

    expect(await closuresOf(restaurantId)).toHaveLength(1);
  });

  it("refuses with a message that names no restaurant, closure or guest", async () => {
    const { restaurantId, tableIds: [tableId] } = await bookableRestaurant(owner.db);
    await insertBooking({ ...booking(restaurantId, tableId, 24, 25), guestName: "Rudo Chikwanha" });

    const failure = await insertClosure(restaurantId, 23, 26).catch((error: Error) => error);

    const text = JSON.stringify((failure as Error).cause);
    expect(text).not.toContain(restaurantId);
    expect(text).not.toContain(tableId);
    expect(text).not.toContain("Rudo");
  });
});

describe("a booking inside a closure", () => {
  it.each(["online", "staff"] as const)("is refused when it is confirmed and %s", async (source) => {
    const { restaurantId, tableIds: [tableId] } = await bookableRestaurant(owner.db);
    await insertClosure(restaurantId, 24, 30);

    await expect(
      insertBooking({ ...booking(restaurantId, tableId, 25, 26.5), source }),
    ).rejects.toMatchObject(INSIDE);
    await expect(
      insertBooking({ ...booking(restaurantId, tableId, 22, 24.5), source }),
    ).rejects.toMatchObject(INSIDE);
    await expect(
      insertBooking({ ...booking(restaurantId, tableId, 23, 31), source }),
    ).rejects.toMatchObject(INSIDE);

    expect(await bookingsOf(owner.db, restaurantId)).toEqual([]);
  });

  it("is allowed when its sitting only touches the closure, or its buffer runs into it", async () => {
    const { restaurantId, tableIds: [tableId, bufferTable] } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 2 }, { capacity: 2 }],
    });
    await insertClosure(restaurantId, 24, 30);

    await insertBooking(booking(restaurantId, tableId, 22, 24));
    await insertBooking(booking(restaurantId, tableId, 30, 31));
    await insertBooking({ ...booking(restaurantId, bufferTable, 22.5, 24.25), endsAt: at(24) });

    expect(await bookingsOf(owner.db, restaurantId)).toHaveLength(3);
  });

  it.each(["seated", "completed", "cancelled", "no_show"] as const)(
    "is allowed when it is %s: a walk-in sits at the door, and the rest is history",
    async (status) => {
      const { restaurantId, tableIds: [tableId] } = await bookableRestaurant(owner.db);
      await insertClosure(restaurantId, -1, 30);

      await insertBooking({ ...booking(restaurantId, tableId, -0.5, 1), status, source: "staff" });

      expect(await bookingsOf(owner.db, restaurantId)).toHaveLength(1);
    },
  );

  it("can't be reopened inside it, and can't have its time moved into it", async () => {
    const { restaurantId, tableIds: [tableId, other] } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 2 }, { capacity: 2 }],
    });
    await insertClosure(restaurantId, 24, 30);
    const cancelled = { ...booking(restaurantId, tableId, 25, 26), status: "cancelled" as const };
    const moving = booking(restaurantId, other, 40, 41);
    await insertBooking(cancelled);
    await insertBooking(moving);

    await expect(
      asTenant(app.db, restaurantId, (tx) =>
        tx.update(bookings).set({ status: "confirmed" }).where(eq(bookings.manageToken, cancelled.manageToken)),
      ),
    ).rejects.toMatchObject(INSIDE);
    await expect(
      asTenant(app.db, restaurantId, (tx) =>
        tx
          .update(bookings)
          .set({ startsAt: at(25), endsAt: at(26), holdEndsAt: at(26) })
          .where(eq(bookings.manageToken, moving.manageToken)),
      ),
    ).rejects.toMatchObject(INSIDE);
  });

  it("doesn't stop a seated walk-in in a closure being finished or moved: only a new claim on the time is judged", async () => {
    const { restaurantId, tableIds: [tableId, other] } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 2 }, { capacity: 2 }],
    });
    await insertClosure(restaurantId, -1, 3);
    const row = { ...booking(restaurantId, tableId, -0.5, 1), status: "seated" as const, source: "staff" as const };
    await insertBooking(row);

    await asTenant(app.db, restaurantId, (tx) =>
      tx.update(bookings).set({ tableId: other }).where(eq(bookings.manageToken, row.manageToken)),
    );
    await asTenant(app.db, restaurantId, (tx) =>
      tx.update(bookings).set({ status: "completed" }).where(eq(bookings.manageToken, row.manageToken)),
    );

    expect((await bookingsOf(owner.db, restaurantId))[0]).toMatchObject({ tableId: other, status: "completed" });
  });

  it("only looks at its own restaurant's closures", async () => {
    const mine = await bookableRestaurant(owner.db);
    const other = await bookableRestaurant(owner.db);
    await insertClosure(other.restaurantId, 23, 26);

    await insertBooking(booking(mine.restaurantId, mine.tableIds[0], 24, 25));

    expect(await bookingsOf(owner.db, mine.restaurantId)).toHaveLength(1);
  });

  it("is judged on the row that was written: a forged restaurant is the policy's refusal, not the guard's", async () => {
    const a = await bookableRestaurant(owner.db);
    const b = await bookableRestaurant(owner.db);
    await insertClosure(b.restaurantId, 23, 26);

    const forged = await asTenant(app.db, a.restaurantId, (tx) =>
      tx.insert(bookings).values(booking(b.restaurantId, b.tableIds[0], 24, 25)),
    ).catch((error: unknown) => error);

    expect(forged).toMatchObject({ cause: { code: "42501" } });
  });
});

describe("a confirm and a closure save at once", () => {
  const backendPid = async (client: PoolClient) =>
    (await client.query("select pg_backend_pid() as pid")).rows[0].pid as number;

  /** The backend blocked on this particular holder: another file's waits can't satisfy it. */
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

  const insertSql = `
    insert into bookings (restaurant_id, table_id, guest_name, whatsapp_opt_in, party_size,
      starts_at, ends_at, hold_ends_at, status, source, manage_token)
    values ($1, $2, 'Racing guest', true, 2, now() + interval '1 day', now() + interval '1 day 90 minutes',
      now() + interval '1 day 105 minutes', 'confirmed', 'online', $3)
  `;
  const insertBookingOn = (client: PoolClient, restaurantId: string, tableId: string) =>
    client.query(insertSql, [restaurantId, tableId, crypto.randomUUID().replaceAll("-", "")]);
  const closureSql = `
    insert into closures (restaurant_id, starts_at, ends_at)
    values ($1, now() + interval '1 day 30 minutes', now() + interval '1 day 3 hours')
  `;

  const fail = (error: { code?: string; constraint?: string }) => `${error.code}/${error.constraint}`;

  /** No connection is left holding a lock if a test fails halfway. */
  const hangUp = (...clients: PoolClient[]) => {
    for (const client of clients) client.release(true);
  };

  /** Confirmed bookings whose sitting runs into a closure of the restaurant. */
  async function bookingsInsideClosures(restaurantId: string) {
    const { rows } = await owner.db.execute<{ n: number }>(sql`
      select count(*)::int as n from bookings b join closures c on c.restaurant_id = b.restaurant_id
      where b.restaurant_id = ${restaurantId} and b.status = 'confirmed'
        and b.starts_at < c.ends_at and c.starts_at < b.ends_at
    `);
    return rows[0].n;
  }

  it("the confirm is in first: the closure save waits for it, then is refused", async () => {
    const { restaurantId, tableIds: [tableId] } = await bookableRestaurant(owner.db);
    const confirmer = await owner.pool.connect();
    const saver = await owner.pool.connect();
    try {
      await confirmer.query("begin");
      await insertBookingOn(confirmer, restaurantId, tableId);
      await saver.query("begin");
      const saverPid = await backendPid(saver);
      const saving = saver.query(closureSql, [restaurantId]).then(() => "saved", fail);
      expect(await blockedBehind(await backendPid(confirmer))).toBe(saverPid);

      await confirmer.query("commit");

      expect(await saving).toBe("23514/closures_cover_bookings");
      await saver.query("rollback");
      expect(await closuresOf(restaurantId)).toEqual([]);
      expect(await bookingsInsideClosures(restaurantId)).toBe(0);
      expect(await bookingsOf(owner.db, restaurantId)).toHaveLength(1);
    } finally {
      hangUp(confirmer, saver);
    }
  });

  it("the closure save is in first: the confirm waits for it, then is refused", async () => {
    const { restaurantId, tableIds: [tableId] } = await bookableRestaurant(owner.db);
    const confirmer = await owner.pool.connect();
    const saver = await owner.pool.connect();
    try {
      await saver.query("begin");
      await saver.query(closureSql, [restaurantId]);
      await confirmer.query("begin");
      const confirmerPid = await backendPid(confirmer);
      const confirming = insertBookingOn(confirmer, restaurantId, tableId).then(() => "confirmed", fail);
      expect(await blockedBehind(await backendPid(saver))).toBe(confirmerPid);

      await saver.query("commit");

      expect(await confirming).toBe("23514/bookings_within_closure");
      await confirmer.query("rollback");
      expect(await closuresOf(restaurantId)).toHaveLength(1);
      expect(await bookingsInsideClosures(restaurantId)).toBe(0);
      expect(await bookingsOf(owner.db, restaurantId)).toEqual([]);
    } finally {
      hangUp(confirmer, saver);
    }
  });

  it("the confirm rolls back: the closure save that waited for it goes through", async () => {
    const { restaurantId, tableIds: [tableId] } = await bookableRestaurant(owner.db);
    const confirmer = await owner.pool.connect();
    const saver = await owner.pool.connect();
    try {
      await confirmer.query("begin");
      await insertBookingOn(confirmer, restaurantId, tableId);
      await saver.query("begin");
      const saving = saver.query(closureSql, [restaurantId]).then(() => "saved", fail);
      await blockedBehind(await backendPid(confirmer));

      await confirmer.query("rollback");

      expect(await saving).toBe("saved");
      await saver.query("commit");
      expect(await closuresOf(restaurantId)).toHaveLength(1);
    } finally {
      hangUp(confirmer, saver);
    }
  });

  it("the closure save rolls back: the confirm that waited for it goes through", async () => {
    const { restaurantId, tableIds: [tableId] } = await bookableRestaurant(owner.db);
    const confirmer = await owner.pool.connect();
    const saver = await owner.pool.connect();
    try {
      await saver.query("begin");
      await saver.query(closureSql, [restaurantId]);
      await confirmer.query("begin");
      const confirming = insertBookingOn(confirmer, restaurantId, tableId).then(() => "confirmed", fail);
      await blockedBehind(await backendPid(saver));

      await saver.query("rollback");

      expect(await confirming).toBe("confirmed");
      await confirmer.query("commit");
      expect(await bookingsOf(owner.db, restaurantId)).toHaveLength(1);
      expect(await closuresOf(restaurantId)).toEqual([]);
    } finally {
      hangUp(confirmer, saver);
    }
  });

  it("two confirms don't queue behind each other: the lock is shared between them", async () => {
    const { restaurantId, tableIds: [one, two] } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 2 }, { capacity: 2 }],
    });
    const first = await owner.pool.connect();
    const second = await owner.pool.connect();
    try {
      await first.query("begin");
      await second.query("begin");
      await insertBookingOn(first, restaurantId, one);
      await insertBookingOn(second, restaurantId, two);
      await first.query("commit");
      await second.query("commit");
      expect(await bookingsOf(owner.db, restaurantId)).toHaveLength(2);
    } finally {
      hangUp(first, second);
    }
  });

  it("another restaurant's closure save doesn't hold a confirm up: the lock is per restaurant", async () => {
    const mine = await bookableRestaurant(owner.db);
    const other = await bookableRestaurant(owner.db);
    const saver = await owner.pool.connect();
    const confirmer = await owner.pool.connect();
    try {
      await saver.query("begin");
      await saver.query(closureSql, [other.restaurantId]);
      await confirmer.query("begin");
      await insertBookingOn(confirmer, mine.restaurantId, mine.tableIds[0]);
      await confirmer.query("commit");
      expect(await bookingsOf(owner.db, mine.restaurantId)).toHaveLength(1);
    } finally {
      hangUp(saver, confirmer);
    }
  });
});
