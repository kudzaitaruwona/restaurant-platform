import type { PoolClient } from "@neondatabase/serverless";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { bookableRestaurant, bookingsOf } from "../../test/integration/bookings";
import { openOwnerDatabase, openTestDatabase } from "../../test/integration/database";

/**
 * Two rules take advisory locks on one booking insert: the per-phone limit
 * (migration 0017) and the archive guard's shared table lock (migration 0016). An
 * archive takes the table lock exclusively. AFTER triggers fire in name order, so
 * an insert always goes foreign keys, then phone, then table, and the exclusion
 * constraint, checked as the row goes in, comes before all of them. These tests
 * stop real connections at each of those points and say who waits on whom: no
 * party that holds a phone's lock ever waits on something the other side holds
 * while waiting for that phone.
 */
const app = openTestDatabase();
const owner = openOwnerDatabase();
afterAll(() => Promise.all([app.pool.end(), owner.pool.end()]));

const PHONE = "+263771220000";
const DEADLOCK = "40P01";
const LIVE = "23514/bookings_table_live";
const OVERLAP = "23P01/bookings_no_overlap";
const GUARD = "23514/tables_archive_guard";

const pidOf = async (client: PoolClient) =>
  (await client.query("select pg_backend_pid() as pid")).rows[0].pid as number;

/** This backend, and no other, is stopped on a lock that `holder` has. */
const waitingOn = (pid: number, holder: number) =>
  vi.waitFor(
    async () => {
      const { rows } = await owner.db.execute<{ wait: string; holders: number[] }>(sql`
        select wait_event_type as wait, pg_blocking_pids(pid) as holders
        from pg_stat_activity where pid = ${pid}`);
      expect(rows[0].wait).toBe("Lock");
      expect(rows[0].holders).toContain(holder);
    },
    { timeout: 5_000, interval: 20 },
  );

/** The advisory locks this backend has, and those it is still waiting for. */
async function advisoryLocksOf(pid: number) {
  const { rows } = await owner.db.execute<{ mode: string; granted: boolean }>(sql`
    select mode, granted from pg_locks where pid = ${pid} and locktype = 'advisory'
    order by granted desc, mode`);
  return rows.map(({ mode, granted }) => `${granted ? "has" : "wants"} ${mode}`);
}

const outcome = (statement: Promise<unknown>) =>
  statement.then(
    () => "passed",
    (error: { code?: string; constraint?: string }) =>
      error.constraint ? `${error.code}/${error.constraint}` : String(error.code),
  );

type Party = PoolClient & { pid: number };

/** A guest's transaction as the app runs it: app_tenant, tenant set, nothing locked yet. */
async function aConfirm(restaurantId: string) {
  const client = await app.pool.connect();
  await client.query("begin");
  await client.query("select set_config('app.restaurant_id', $1, true)", [restaurantId]);
  return Object.assign(client, { pid: await pidOf(client) }) as Party;
}

/** An owner archiving a table: the same role, and nothing held until the update. */
async function anArchive() {
  const client = await app.pool.connect();
  await client.query("begin");
  return Object.assign(client, { pid: await pidOf(client) }) as Party;
}

const archive = (client: Party, restaurantId: string, tableId: string) =>
  client
    .query("select set_config('app.restaurant_id', $1, true)", [restaurantId])
    .then(() => client.query("update tables set archived_at = now() where id = $1", [tableId]));

const insert = (client: Party, restaurantId: string, tableId: string, inDays: number) =>
  client.query(
    `insert into bookings (restaurant_id, table_id, guest_name, guest_phone, whatsapp_opt_in, party_size,
       starts_at, ends_at, hold_ends_at, status, source, manage_token)
     values ($1, $2, 'Guest', $3, true, 2,
       date_trunc('hour', now()) + $4 * interval '1 day',
       date_trunc('hour', now()) + $4 * interval '1 day' + interval '90 minutes',
       date_trunc('hour', now()) + $4 * interval '1 day' + interval '105 minutes',
       'confirmed', 'online', $5)`,
    [restaurantId, tableId, PHONE, inDays, crypto.randomUUID().replaceAll("-", "")],
  );

const restaurant = (limit = 2) =>
  bookableRestaurant(owner.db, {
    tables: [{ capacity: 2 }, { capacity: 2 }, { capacity: 2 }],
    rules: { maxActiveBookingsPerPhone: limit },
  });

/** No connection is left holding a lock if a test fails halfway. */
const hangUp = (...parties: PoolClient[]) => {
  for (const party of parties) party.release(true);
};

describe("the triggers on a booking insert", () => {
  it("fire phone first, table second, after the foreign keys", async () => {
    const { rows } = await owner.db.execute<{ name: string }>(sql`
      select tgname as name from pg_trigger
      where tgrelid = 'bookings'::regclass and tgtype & 4 <> 0 and tgtype & 2 = 0
      order by tgname collate "C"`);
    const names = rows.map(({ name }) => name.replace(/_c_[0-9]+$/, ""));

    expect(names).toEqual([
      "RI_ConstraintTrigger",
      "RI_ConstraintTrigger",
      "bookings_max_active_per_phone",
      "bookings_table_live_insert",
    ]);
  });
});

describe("a confirm and an archive, one phone and one table", () => {
  it("an archive in first stops the confirm at the table, holding the phone; a second confirm queues on the phone; nothing deadlocks", async () => {
    const { restaurantId, tableIds: [archived, other] } = await restaurant();
    const archiver = await anArchive();
    const first = await aConfirm(restaurantId);
    const second = await aConfirm(restaurantId);
    try {
      await archive(archiver, restaurantId, archived);

      const firstResult = outcome(insert(first, restaurantId, archived, 3));
      await waitingOn(first.pid, archiver.pid);
      // The firing order, seen on the wire: the phone's lock taken, the table's still wanted.
      expect(await advisoryLocksOf(first.pid)).toEqual(["has ExclusiveLock", "wants ShareLock"]);

      const secondResult = outcome(insert(second, restaurantId, other, 4));
      await waitingOn(second.pid, first.pid);
      expect(await advisoryLocksOf(second.pid)).toEqual(["wants ExclusiveLock"]);

      await archiver.query("commit");

      expect(await firstResult).toBe(LIVE);
      await first.query("rollback");
      expect(await secondResult).toBe("passed");
      await second.query("commit");
      expect((await bookingsOf(owner.db, restaurantId)).map(({ tableId }) => tableId)).toEqual([other]);
    } finally {
      hangUp(archiver, first, second);
    }
  });

  it("a confirm in first makes the archive wait; a second confirm on that phone and table queues behind it; the archive is refused", async () => {
    const { restaurantId, tableIds: [table] } = await restaurant();
    const first = await aConfirm(restaurantId);
    const second = await aConfirm(restaurantId);
    const archiver = await anArchive();
    try {
      await insert(first, restaurantId, table, 3);
      expect(await advisoryLocksOf(first.pid)).toEqual(["has ExclusiveLock", "has ShareLock"]);

      const archiving = outcome(archive(archiver, restaurantId, table));
      await waitingOn(archiver.pid, first.pid);
      const secondResult = outcome(insert(second, restaurantId, table, 4));
      await waitingOn(second.pid, first.pid);

      await first.query("commit");

      expect(await archiving).toBe(GUARD);
      await archiver.query("rollback");
      expect(await secondResult).toBe("passed");
      await second.query("commit");
      expect(await bookingsOf(owner.db, restaurantId)).toHaveLength(2);
    } finally {
      hangUp(first, second, archiver);
    }
  });
});

describe("two confirms, one phone, the same two tables in opposite order", () => {
  /**
   * The one way this could cycle is a confirm holding the phone while it waits on
   * the other's row. An attempt that fails gives the phone back with its savepoint,
   * so the retry holds nothing the other wants.
   */
  it("the first's refused attempt frees the phone for the second, and its retry then waits on the second, not the reverse", async () => {
    const { restaurantId, tableIds: [one, two] } = await restaurant();
    const archiver = await anArchive();
    const first = await aConfirm(restaurantId);
    const second = await aConfirm(restaurantId);
    try {
      await archive(archiver, restaurantId, one);

      await first.query("savepoint attempt");
      const firstAttempt = outcome(insert(first, restaurantId, one, 3));
      await waitingOn(first.pid, archiver.pid);

      await second.query("savepoint attempt");
      const secondAttempt = outcome(insert(second, restaurantId, two, 3));
      await waitingOn(second.pid, first.pid);

      await archiver.query("commit");
      expect(await firstAttempt).toBe(LIVE);
      // The transaction is still open, and its row is gone: only the savepoint ended.
      await first.query("rollback to savepoint attempt");
      expect(await advisoryLocksOf(first.pid)).toEqual([]);
      expect(await secondAttempt).toBe("passed");

      await first.query("savepoint attempt");
      const retry = outcome(insert(first, restaurantId, two, 3));
      await waitingOn(first.pid, second.pid);
      expect(await advisoryLocksOf(first.pid)).toEqual([]);
      await second.query("commit");

      expect(await retry).toBe(OVERLAP);
      await first.query("rollback");
      expect((await bookingsOf(owner.db, restaurantId)).map(({ tableId }) => tableId)).toEqual([two]);
    } finally {
      hangUp(archiver, first, second);
    }
  });

  it("landing together on each other's tables: one waits on the phone, one takes it, and the limit holds", async () => {
    const { restaurantId, tableIds: [one, two] } = await restaurant(1);
    const first = await aConfirm(restaurantId);
    const second = await aConfirm(restaurantId);
    try {
      await insert(first, restaurantId, one, 3);
      const racing = outcome(insert(second, restaurantId, two, 3));
      await waitingOn(second.pid, first.pid);

      await first.query("commit");

      expect(await racing).toBe("23514/bookings_max_active_per_phone");
      await second.query("rollback");
      expect((await bookingsOf(owner.db, restaurantId)).map(({ tableId }) => tableId)).toEqual([one]);
    } finally {
      hangUp(first, second);
    }
  });

  it("is why one transaction must not hold a booking and try another: that does deadlock", async () => {
    const { restaurantId, tableIds: [one, two] } = await restaurant(3);
    const first = await aConfirm(restaurantId);
    const second = await aConfirm(restaurantId);
    try {
      await insert(first, restaurantId, one, 3);
      const secondResult = outcome(insert(second, restaurantId, two, 3));
      await waitingOn(second.pid, first.pid);

      const firstResult = outcome(insert(first, restaurantId, two, 3));

      expect([await firstResult, await secondResult]).toContain(DEADLOCK);
    } finally {
      hangUp(first, second);
    }
  });
});
