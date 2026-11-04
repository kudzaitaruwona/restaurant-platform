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
import { bookings, bookingSettings, diningTables } from "./schema";

/**
 * The archive guard (spec 03, migration 0016): written straight at Postgres, as
 * app_tenant where the app would be, with nothing of the app's own checks in the way.
 */
const app = openTestDatabase();
const owner = openOwnerDatabase();
afterAll(() => Promise.all([app.pool.end(), owner.pool.end()]));

const MINUTE = 60_000;
const HOUR = 3_600_000;
const at = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();

const GUARD = { cause: { code: "23514", constraint: "tables_archive_guard" } };
const LIVE = { cause: { code: "23514", constraint: "bookings_table_live" } };

/** A confirmed booking from `from` to `to` hours from now. */
const booking = (restaurantId: string, tableId: string, from: number, to: number) =>
  aBooking(restaurantId, tableId, at(from), at(to));

const insert = (row: typeof bookings.$inferInsert) =>
  asTenant(app.db, row.restaurantId, (tx) => tx.insert(bookings).values(row));

const archive = (restaurantId: string, tableId: string) =>
  asTenant(app.db, restaurantId, (tx) =>
    tx.update(diningTables).set({ archivedAt: new Date() }).where(eq(diningTables.id, tableId)),
  );

const archivedAt = async (tableId: string) =>
  (await owner.db.select().from(diningTables).where(eq(diningTables.id, tableId)))[0].archivedAt;

const enabled = async (restaurantId: string) =>
  (
    await owner.db
      .select({ enabled: bookingSettings.enabled })
      .from(bookingSettings)
      .where(eq(bookingSettings.restaurantId, restaurantId))
  )[0].enabled;

describe("archiving a table", () => {
  it.each(["confirmed", "seated"] as const)(
    "is refused while a future %s booking holds it, and nothing changes",
    async (status) => {
      const { restaurantId, tableIds: [tableId] } = await bookableRestaurant(owner.db);
      await insert({ ...booking(restaurantId, tableId, 24, 26), status });

      await expect(archive(restaurantId, tableId)).rejects.toMatchObject(GUARD);

      expect(await archivedAt(tableId)).toBeNull();
    },
  );

  it("counts a seated booking whose start has passed, and a late confirmed one: the hold hasn't ended", async () => {
    const { restaurantId, tableIds: [tableA, tableB] } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 2 }, { capacity: 2 }],
    });
    await insert({ ...booking(restaurantId, tableA, -1, 1), status: "seated" });
    await insert({ ...booking(restaurantId, tableB, -0.5, 1), status: "confirmed" });

    await expect(archive(restaurantId, tableA)).rejects.toMatchObject(GUARD);
    await expect(archive(restaurantId, tableB)).rejects.toMatchObject(GUARD);
  });

  // The guard reads back only as far as bookings_hold_capped allows, so this is the
  // oldest booking that can still hold a table: lowering the bound would miss it.
  it("reaches back to the longest hold there can be", async () => {
    const { restaurantId, tableIds: [tableId] } = await bookableRestaurant(owner.db);
    const holdEnds = Date.now() + 2 * MINUTE;
    await insert({
      ...aBooking(
        restaurantId,
        tableId,
        new Date(holdEnds - 960 * MINUTE).toISOString(),
        new Date(holdEnds).toISOString(),
      ),
      status: "seated",
    });

    await expect(archive(restaurantId, tableId)).rejects.toMatchObject(GUARD);
  });

  it.each(["completed", "cancelled", "no_show"] as const)(
    "is allowed with only a %s booking",
    async (status) => {
      const { restaurantId, tableIds: [tableId] } = await bookableRestaurant(owner.db);
      await insert({ ...booking(restaurantId, tableId, 24, 26), status });

      await archive(restaurantId, tableId);

      expect(await archivedAt(tableId)).not.toBeNull();
    },
  );

  it("is allowed once the hold has ended, and with no bookings at all", async () => {
    const { restaurantId, tableIds: [past, empty] } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 2 }, { capacity: 2 }, { capacity: 2 }],
    });
    await insert(booking(restaurantId, past, -5, -3));

    await archive(restaurantId, past);
    await archive(restaurantId, empty);

    expect(await archivedAt(past)).not.toBeNull();
    expect(await archivedAt(empty)).not.toBeNull();
  });

  it("only looks at its own table's bookings", async () => {
    const { restaurantId, tableIds: [busy, quiet] } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 2 }, { capacity: 2 }, { capacity: 2 }],
    });
    await insert(booking(restaurantId, busy, 24, 26));

    await archive(restaurantId, quiet);

    expect(await archivedAt(quiet)).not.toBeNull();
    expect(await archivedAt(busy)).toBeNull();
  });

  it("is allowed again once the booking is cancelled", async () => {
    const { restaurantId, tableIds: [tableId] } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 2 }, { capacity: 2 }],
    });
    const row = booking(restaurantId, tableId, 24, 26);
    await insert(row);
    await expect(archive(restaurantId, tableId)).rejects.toMatchObject(GUARD);

    await owner.db.update(bookings).set({ status: "cancelled" }).where(eq(bookings.manageToken, row.manageToken));
    await archive(restaurantId, tableId);

    expect(await archivedAt(tableId)).not.toBeNull();
  });

  it("reports nothing about another restaurant: a forged update finds no row to guard", async () => {
    const a = await bookableRestaurant(owner.db);
    const b = await bookableRestaurant(owner.db);
    await insert(booking(b.restaurantId, b.tableIds[0], 24, 26));

    // A's context aimed at B's table: RLS hides the row, so no trigger runs and no refusal names B.
    const result = await archive(a.restaurantId, b.tableIds[0]);

    expect(result.rowCount).toBe(0);
    expect(await archivedAt(b.tableIds[0])).toBeNull();
  });

  it("refuses with a message that names no restaurant, table or guest", async () => {
    const { restaurantId, tableIds: [tableId] } = await bookableRestaurant(owner.db);
    await insert({ ...booking(restaurantId, tableId, 24, 26), guestName: "Rudo Chikwanha" });

    const failure = await archive(restaurantId, tableId).catch((error: Error) => error);

    // What Postgres said, not drizzle's echo of the statement the app sent.
    const text = JSON.stringify((failure as Error).cause);
    expect(text).not.toContain(restaurantId);
    expect(text).not.toContain(tableId);
    expect(text).not.toContain("Rudo");
  });
});

describe("a booking on an archived table", () => {
  async function archivedTable(options?: Parameters<typeof bookableRestaurant>[1]) {
    const fixture = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 2 }, { capacity: 2 }],
      ...options,
    });
    await archive(fixture.restaurantId, fixture.tableIds[0]);
    return fixture;
  }

  it.each(["confirmed", "seated"] as const)("is refused when it is %s and holds the table", async (status) => {
    const { restaurantId, tableIds: [tableId] } = await archivedTable();

    await expect(insert({ ...booking(restaurantId, tableId, 24, 26), status })).rejects.toMatchObject(LIVE);

    expect(await bookingsOf(owner.db, restaurantId)).toEqual([]);
  });

  it.each(["completed", "cancelled", "no_show"] as const)(
    "is allowed as history when it is %s",
    async (status) => {
      const { restaurantId, tableIds: [tableId] } = await archivedTable();

      await insert({ ...booking(restaurantId, tableId, 24, 26), status });

      expect(await bookingsOf(owner.db, restaurantId)).toHaveLength(1);
    },
  );

  it("is allowed when its hold has already ended", async () => {
    const { restaurantId, tableIds: [tableId] } = await archivedTable();

    await insert(booking(restaurantId, tableId, -5, -3));

    expect(await bookingsOf(owner.db, restaurantId)).toHaveLength(1);
  });

  it("can't be moved onto it, or reopened on it", async () => {
    const { restaurantId, tableIds: [gone, live] } = await archivedTable();
    const moving = booking(restaurantId, live, 24, 26);
    const cancelled = { ...booking(restaurantId, gone, 48, 50), status: "cancelled" as const };
    await insert(moving);
    await insert(cancelled);

    await expect(
      asTenant(app.db, restaurantId, (tx) =>
        tx.update(bookings).set({ tableId: gone }).where(eq(bookings.manageToken, moving.manageToken)),
      ),
    ).rejects.toMatchObject(LIVE);
    await expect(
      asTenant(app.db, restaurantId, (tx) =>
        tx.update(bookings).set({ status: "confirmed" }).where(eq(bookings.manageToken, cancelled.manageToken)),
      ),
    ).rejects.toMatchObject(LIVE);
  });

  it("can still change state where it already is: a seating or a move between live tables", async () => {
    const { restaurantId, tableIds: [tableId, other] } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 2 }, { capacity: 2 }],
    });
    const row = booking(restaurantId, tableId, 1, 3);
    await insert(row);

    await asTenant(app.db, restaurantId, (tx) =>
      tx.update(bookings).set({ status: "seated" }).where(eq(bookings.manageToken, row.manageToken)),
    );
    await asTenant(app.db, restaurantId, (tx) =>
      tx.update(bookings).set({ tableId: other }).where(eq(bookings.manageToken, row.manageToken)),
    );

    expect((await bookingsOf(owner.db, restaurantId))[0]).toMatchObject({ tableId: other, status: "seated" });
  });

  it("is judged on the row that was written: a forged restaurant is the policy's refusal, not the guard's", async () => {
    const a = await bookableRestaurant(owner.db);
    const b = await archivedTable();

    // A's context writing B's restaurant id on B's archived table: the row policy answers first.
    const forged = await asTenant(app.db, a.restaurantId, (tx) =>
      tx.insert(bookings).values(booking(b.restaurantId, b.tableIds[0], 24, 26)),
    ).catch((error: unknown) => error);

    expect(forged).toMatchObject({ cause: { code: "42501" } });
  });
});

describe("a booking and the bookable flag", () => {
  it("an online booking is refused on a walk-in-only table; a staff booking is not", async () => {
    const { restaurantId, tableIds: [bar] } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 2, bookable: false }, { capacity: 2 }],
    });

    await expect(insert(booking(restaurantId, bar, 24, 26))).rejects.toMatchObject({
      cause: { code: "23514", constraint: "bookings_table_bookable" },
    });
    await insert({ ...booking(restaurantId, bar, 24, 26), source: "staff" });

    expect(await bookingsOf(owner.db, restaurantId)).toHaveLength(1);
  });
});

describe("the gate and the guard", () => {
  it("a refused archive of the last bookable table leaves online booking on", async () => {
    const { restaurantId, tableIds: [tableId] } = await bookableRestaurant(owner.db);
    await insert(booking(restaurantId, tableId, 24, 26));

    await expect(archive(restaurantId, tableId)).rejects.toMatchObject(GUARD);

    expect(await enabled(restaurantId)).toBe(true);
    expect(await archivedAt(tableId)).toBeNull();
  });

  it("an archive of the last bookable table with nothing booked still switches it off", async () => {
    const { restaurantId, tableIds: [tableId] } = await bookableRestaurant(owner.db);

    await archive(restaurantId, tableId);

    expect(await enabled(restaurantId)).toBe(false);
    expect(await archivedAt(tableId)).not.toBeNull();
  });
});

describe("a confirm and an archive at once", () => {
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
  const insertBooking = (client: PoolClient, restaurantId: string, tableId: string) =>
    client.query(insertSql, [restaurantId, tableId, crypto.randomUUID().replaceAll("-", "")]);
  const archiveSql = "update tables set archived_at = now() where id = $1";

  const fail = (error: { code?: string; constraint?: string }) => `${error.code}/${error.constraint}`;

  /** No connection is left holding a lock if a test fails halfway. */
  const hangUp = (...clients: PoolClient[]) => {
    for (const client of clients) client.release(true);
  };

  /** A restaurant with a second bookable table, so archiving the first isn't also the gate's switch-off. */
  const twoTables = () =>
    bookableRestaurant(owner.db, { tables: [{ capacity: 2 }, { capacity: 2 }] });

  async function futureBookingsOnArchivedTables(restaurantId: string) {
    const { rows } = await owner.db.execute<{ n: number }>(sql`
      select count(*)::int as n from bookings b join tables t on t.id = b.table_id
      where b.restaurant_id = ${restaurantId} and t.archived_at is not null
        and b.status in ('confirmed', 'seated') and b.hold_ends_at > now()
    `);
    return rows[0].n;
  }

  it("the confirm is in first: the archive waits for it, then is refused", async () => {
    const { restaurantId, tableIds: [tableId] } = await twoTables();
    const confirmer = await owner.pool.connect();
    const archiver = await owner.pool.connect();
    try {
      await confirmer.query("begin");
      await insertBooking(confirmer, restaurantId, tableId);
      await archiver.query("begin");
      const archiverPid = await backendPid(archiver);
      const archiving = archiver.query(archiveSql, [tableId]).then(
        () => "archived",
        fail,
      );
      expect(await blockedBehind(await backendPid(confirmer))).toBe(archiverPid);

      await confirmer.query("commit");

      expect(await archiving).toBe("23514/tables_archive_guard");
      await archiver.query("rollback");
      expect(await archivedAt(tableId)).toBeNull();
      expect(await futureBookingsOnArchivedTables(restaurantId)).toBe(0);
      expect(await bookingsOf(owner.db, restaurantId)).toHaveLength(1);
    } finally {
      hangUp(confirmer, archiver);
    }
  });

  it("the archive is in first: the confirm waits for it, then is refused", async () => {
    const { restaurantId, tableIds: [tableId] } = await twoTables();
    const confirmer = await owner.pool.connect();
    const archiver = await owner.pool.connect();
    try {
      await archiver.query("begin");
      await archiver.query(archiveSql, [tableId]);
      await confirmer.query("begin");
      const confirmerPid = await backendPid(confirmer);
      const confirming = insertBooking(confirmer, restaurantId, tableId).then(
        () => "confirmed",
        fail,
      );
      expect(await blockedBehind(await backendPid(archiver))).toBe(confirmerPid);

      await archiver.query("commit");

      expect(await confirming).toBe("23514/bookings_table_live");
      await confirmer.query("rollback");
      expect(await archivedAt(tableId)).not.toBeNull();
      expect(await futureBookingsOnArchivedTables(restaurantId)).toBe(0);
      expect(await bookingsOf(owner.db, restaurantId)).toEqual([]);
    } finally {
      hangUp(confirmer, archiver);
    }
  });

  it("the confirm rolls back: the archive that waited for it goes through", async () => {
    const { restaurantId, tableIds: [tableId] } = await twoTables();
    const confirmer = await owner.pool.connect();
    const archiver = await owner.pool.connect();
    try {
      await confirmer.query("begin");
      await insertBooking(confirmer, restaurantId, tableId);
      await archiver.query("begin");
      const archiverPid = await backendPid(archiver);
      const archiving = archiver.query(archiveSql, [tableId]).then(() => "archived", fail);
      expect(await blockedBehind(await backendPid(confirmer))).toBe(archiverPid);

      await confirmer.query("rollback");

      expect(await archiving).toBe("archived");
      await archiver.query("commit");
      expect(await archivedAt(tableId)).not.toBeNull();
    } finally {
      hangUp(confirmer, archiver);
    }
  });

  it("two confirms for one table don't queue behind each other on the guard", async () => {
    // Shared, not exclusive: both inserts hold it at once. (The second waits on the
    // exclusion constraint's unfinished row, which is another lock; table 2 has none.)
    const { restaurantId, tableIds: [one, two] } = await twoTables();
    const first = await owner.pool.connect();
    const second = await owner.pool.connect();
    try {
      await first.query("begin");
      await insertBooking(first, restaurantId, one);
      await second.query("begin");
      await insertBooking(second, restaurantId, two);
      await first.query("commit");
      await second.query("commit");
    } finally {
      hangUp(first, second);
    }
    expect(await bookingsOf(owner.db, restaurantId)).toHaveLength(2);
  });

  it("a table row held NO KEY UPDATE, as moveTable holds it, doesn't make a confirm wait", async () => {
    const { restaurantId, tableIds: [tableId] } = await twoTables();
    const mover = await owner.pool.connect();
    const confirmer = await owner.pool.connect();
    try {
      await mover.query("begin");
      await mover.query("select id from tables where id = $1 for no key update", [tableId]);
      await confirmer.query("begin");
      await confirmer.query("set local lock_timeout = '2s'");
      await insertBooking(confirmer, restaurantId, tableId);
      await confirmer.query("commit");
    } finally {
      hangUp(mover, confirmer);
    }
    expect(await bookingsOf(owner.db, restaurantId)).toHaveLength(1);
  });

  it("a move, a confirm in flight and two archives (the gate's recheck among them) all finish", async () => {
    // An archive takes the table's guard, then the settings row. The move holds NO KEY UPDATE
    // on every table, the confirm a shared guard: none of them takes those the other way round.
    const { restaurantId, tableIds: [one, two] } = await twoTables();
    const confirmer = await owner.pool.connect();
    const mover = await owner.pool.connect();
    const archiverOne = await owner.pool.connect();
    const archiverTwo = await owner.pool.connect();
    try {
      await confirmer.query("begin");
      await insertBooking(confirmer, restaurantId, two);
      await mover.query("begin");
      await mover.query(
        "select id from tables where restaurant_id = $1 order by id for no key update",
        [restaurantId],
      );

      // A busy connection can't be asked for its pid, so both are read first.
      const pidOne = await backendPid(archiverOne);
      const pidTwo = await backendPid(archiverTwo);
      const archivingOne = archiverOne.query(archiveSql, [one]).then(() => "archived", fail);
      expect(await blockedBehind(await backendPid(mover))).toBe(pidOne);
      await mover.query("update tables set sort_order = sort_order + 1 where restaurant_id = $1", [
        restaurantId,
      ]);
      await mover.query("commit");
      expect(await archivingOne).toBe("archived");

      const archivingTwo = archiverTwo.query(archiveSql, [two]).then(() => "archived", fail);
      expect(await blockedBehind(await backendPid(confirmer))).toBe(pidTwo);
      await confirmer.query("commit");

      expect(await archivingTwo).toBe("23514/tables_archive_guard");
      expect(await futureBookingsOnArchivedTables(restaurantId)).toBe(0);
      expect(await enabled(restaurantId)).toBe(true);
    } finally {
      hangUp(confirmer, mover, archiverOne, archiverTwo);
    }
  });
});
