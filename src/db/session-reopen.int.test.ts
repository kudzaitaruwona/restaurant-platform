import type { PoolClient } from "@neondatabase/serverless";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { openOwnerDatabase, openTestDatabase } from "../../test/integration/database";
import { orderingRestaurant } from "../../test/integration/ordering";
import { diningTables, tableSessions } from "./schema";

/**
 * Reopening a closed session (spec 00, Enforced in the database; spec 06,
 * Sessions; #76): only within 15 minutes of its close, and only if no session
 * has opened on that table since, even one that has itself closed again. Held
 * by Postgres (trigger table_sessions_reopen), whoever writes the row, and the
 * table lock (table_sessions_one_open_per_table) settles a reopen racing a scan.
 * Written straight at Postgres with none of the app's checks in the way; the
 * staff action is tested in src/lib/reopen.int.test.ts.
 */
const app = openTestDatabase();
const owner = openOwnerDatabase();
afterAll(() => Promise.all([app.pool.end(), owner.pool.end()]));

type Restaurant = Awaited<ReturnType<typeof orderingRestaurant>>;

const WINDOW = "23514/table_sessions_reopen_window";
const NEWER = "23514/table_sessions_reopen_newer_session";
const ISOLATION = "23514/table_sessions_reopen";
const TABLE_LOCK = "23505/table_sessions_one_open_per_table";

/**
 * A session on the table, opened `opened` minutes ago and closed `closed`
 * minutes ago (by staff, with who), or still open when `closed` is null. Minutes
 * on Postgres's clock, which is the one the rule reads.
 */
async function aSession(
  r: Restaurant,
  { opened, closed, tableId = r.tableId }: { opened: number; closed: number | null; tableId?: string },
) {
  const { rows } = await owner.db.execute<{ id: string }>(sql`
    insert into table_sessions (restaurant_id, table_id, status, opened_at, last_activity_at, closed_at, close_reason, closed_by)
    values (
      ${r.restaurantId}, ${tableId}, ${closed === null ? "open" : "closed"},
      now() - make_interval(secs => ${opened * 60}), now() - make_interval(secs => ${(closed ?? 0) * 60}),
      ${closed === null ? null : sql`now() - make_interval(secs => ${closed * 60})`},
      ${closed === null ? null : "staff_clear"}, ${closed === null ? null : r.staffId})
    returning id`);
  return rows[0].id;
}

const REOPEN = "update table_sessions set status = 'open' where id = $1";
const SCAN = `insert into table_sessions (restaurant_id, table_id) values ($1, $2)
  on conflict (table_id) where status = 'open' do update set last_activity_at = now()
  returning id`;

const outcome = (statement: Promise<unknown>) =>
  statement.then(
    () => "passed",
    (error: { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } }) => {
      const e = error.cause ?? error;
      return e.constraint ? `${e.code}/${e.constraint}` : String(e.code);
    },
  );

type Party = PoolClient & { pid: number };

/** A transaction as the app runs it: app_tenant, inside the tenant, nothing locked yet. */
async function aTenant(restaurantId: string, isolation = "read committed") {
  const client = await app.pool.connect();
  await client.query(`begin isolation level ${isolation}`);
  await client.query("select set_config('app.restaurant_id', $1, true)", [restaurantId]);
  const { rows } = await client.query("select pg_backend_pid() as pid");
  return Object.assign(client, { pid: rows[0].pid as number }) as Party;
}

/** One statement as app_tenant, committed if it passes. */
async function asTenant(restaurantId: string, statement: string, values: unknown[]) {
  const tenant = await aTenant(restaurantId);
  try {
    const result = await outcome(tenant.query(statement, values));
    await tenant.query(result === "passed" ? "commit" : "rollback");
    return result;
  } finally {
    tenant.release();
  }
}

/** This backend is stopped on a lock that `holder` has. */
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

const hangUp = (...parties: PoolClient[]) => {
  for (const party of parties) party.release(true);
};

const rowOf = async (id: string) =>
  (await owner.db.select().from(tableSessions).where(eq(tableSessions.id, id)))[0];
const openOn = async (tableId: string) =>
  (await owner.db.select({ id: tableSessions.id, status: tableSessions.status }).from(tableSessions)
    .where(eq(tableSessions.tableId, tableId))).filter((s) => s.status === "open").map((s) => s.id);

describe("reopening a closed session", () => {
  it("works at 14 minutes: open again, the close forgotten, and active now", async () => {
    const r = await orderingRestaurant(owner.db);
    const id = await aSession(r, { opened: 120, closed: 14 });

    expect(await asTenant(r.restaurantId, REOPEN, [id])).toBe("passed");

    const row = await rowOf(id);
    expect(row).toMatchObject({ status: "open", closedAt: null, closeReason: null, closedBy: null });
    // Reset by the rule itself, whoever writes the row, so idle expiry doesn't close it again at once.
    const { rows } = await owner.db.execute<{ fresh: boolean }>(
      sql`select last_activity_at > now() - interval '1 minute' as fresh from table_sessions where id = ${id}`,
    );
    expect(rows[0].fresh).toBe(true);
  });

  it("is refused at 16 minutes, and the session stays closed", async () => {
    const r = await orderingRestaurant(owner.db);
    const id = await aSession(r, { opened: 120, closed: 16 });

    expect(await asTenant(r.restaurantId, REOPEN, [id])).toBe(WINDOW);
    expect(await rowOf(id)).toMatchObject({ status: "closed", closeReason: "staff_clear", closedBy: r.staffId });
  });

  it("is refused if a new party has opened the table since and is still there", async () => {
    const r = await orderingRestaurant(owner.db);
    const id = await aSession(r, { opened: 60, closed: 10 });
    const newer = await aSession(r, { opened: 5, closed: null });

    expect(await asTenant(r.restaurantId, REOPEN, [id])).toBe(NEWER);
    expect(await openOn(r.tableId)).toEqual([newer]);
  });

  it("is refused if a new party has opened the table since, even if that party's session has already closed", async () => {
    const r = await orderingRestaurant(owner.db);
    const id = await aSession(r, { opened: 60, closed: 10 });
    await aSession(r, { opened: 8, closed: 2 });

    expect(await asTenant(r.restaurantId, REOPEN, [id])).toBe(NEWER);
    expect((await rowOf(id)).status).toBe("closed");
  });

  it("is refused if a party opened the table after this one did, even stamped before this one's close", async () => {
    // A scan whose transaction began just before the close committed, and that
    // waited on the table lock until it had, opens a session stamped a moment
    // before the close. It still came after: the rule compares with when this
    // session opened, and only one session can be open on a table at a time.
    const r = await orderingRestaurant(owner.db);
    const id = await aSession(r, { opened: 60, closed: 10 });
    await aSession(r, { opened: 10.01, closed: 3 });

    expect(await asTenant(r.restaurantId, REOPEN, [id])).toBe(NEWER);
  });

  it("isn't held back by the table's earlier sessions, or by sessions on other tables", async () => {
    const r = await orderingRestaurant(owner.db);
    await aSession(r, { opened: 300, closed: 240 });
    await aSession(r, { opened: 200, closed: 130 });
    const [{ id: otherTable }] = await owner.db
      .insert(diningTables)
      .values({ restaurantId: r.restaurantId, label: "Table 8", capacity: 2, qrToken: crypto.randomUUID().replaceAll("-", "").slice(0, 22) })
      .returning({ id: diningTables.id });
    await aSession(r, { opened: 5, closed: null, tableId: otherTable });
    const id = await aSession(r, { opened: 120, closed: 5 });

    expect(await asTenant(r.restaurantId, REOPEN, [id])).toBe("passed");
    expect(await openOn(r.tableId)).toEqual([id]);
  });

  it("holds whoever writes the row: the owner role, which RLS skips, is refused too", async () => {
    const r = await orderingRestaurant(owner.db);
    const late = await aSession(r, { opened: 120, closed: 16 });
    expect(
      await outcome(owner.db.update(tableSessions).set({ status: "open" }).where(eq(tableSessions.id, late))),
    ).toBe(WINDOW);

    const s = await orderingRestaurant(owner.db);
    const superseded = await aSession(s, { opened: 60, closed: 10 });
    await aSession(s, { opened: 8, closed: 2 });
    expect(
      await outcome(owner.db.update(tableSessions).set({ status: "open" }).where(eq(tableSessions.id, superseded))),
    ).toBe(NEWER);
  });

  it("can be reopened again after closing again, its window counted from the latest close", async () => {
    const r = await orderingRestaurant(owner.db);
    const id = await aSession(r, { opened: 120, closed: 14 });
    expect(await asTenant(r.restaurantId, REOPEN, [id])).toBe("passed");
    await owner.db.execute(sql`
      update table_sessions set status = 'closed', closed_at = now(), close_reason = 'staff_clear' where id = ${id}`);

    expect(await asTenant(r.restaurantId, REOPEN, [id])).toBe("passed");
  });

  it("refuses a reopen under REPEATABLE READ, whose snapshot could miss a party committed meanwhile", async () => {
    const r = await orderingRestaurant(owner.db);
    const id = await aSession(r, { opened: 60, closed: 5 });
    const tenant = await aTenant(r.restaurantId, "repeatable read");
    try {
      expect(await outcome(tenant.query(REOPEN, [id]))).toBe(ISOLATION);
      await tenant.query("rollback");
    } finally {
      hangUp(tenant);
    }
    expect((await rowOf(id)).status).toBe("closed");
  });

  it("leaves every other write alone: a close, and a change to a closed session that doesn't reopen it", async () => {
    const r = await orderingRestaurant(owner.db);
    const old = await aSession(r, { opened: 300, closed: 200 });
    expect(
      await outcome(owner.db.update(tableSessions).set({ status: "closed" }).where(eq(tableSessions.id, old))),
    ).toBe("passed");
    expect((await rowOf(old)).closedAt).not.toBeNull();

    const open = await aSession(r, { opened: 5, closed: null });
    expect(
      await asTenant(
        r.restaurantId,
        "update table_sessions set status = 'closed', closed_at = now(), close_reason = 'staff_clear' where id = $1",
        [open],
      ),
    ).toBe("passed");
  });
});

describe("a reopen and a scan of the same table at the same moment", () => {
  it("a scan in first makes the reopen wait on the table lock, and the reopen is then refused: never two open", async () => {
    const r = await orderingRestaurant(owner.db);
    const id = await aSession(r, { opened: 60, closed: 5 });
    const scanning = await aTenant(r.restaurantId);
    const reopening = await aTenant(r.restaurantId);
    try {
      const { rows } = await scanning.query(SCAN, [r.restaurantId, r.tableId]);
      const fresh = rows[0].id as string;

      const reopened = outcome(reopening.query(REOPEN, [id]));
      await waitingOn(reopening.pid, scanning.pid);
      await scanning.query("commit");

      expect(await reopened).toBe(TABLE_LOCK);
      await reopening.query("rollback");
      expect(await openOn(r.tableId)).toEqual([fresh]);
    } finally {
      hangUp(scanning, reopening);
    }
    expect((await rowOf(id)).status).toBe("closed");
  });

  it("a reopen in first makes the scan wait on the table lock, and the scan then joins the reopened session", async () => {
    const r = await orderingRestaurant(owner.db);
    const id = await aSession(r, { opened: 60, closed: 5 });
    const reopening = await aTenant(r.restaurantId);
    const scanning = await aTenant(r.restaurantId);
    try {
      expect(await outcome(reopening.query(REOPEN, [id]))).toBe("passed");

      const scanned = scanning.query(SCAN, [r.restaurantId, r.tableId]);
      await waitingOn(scanning.pid, reopening.pid);
      await reopening.query("commit");

      expect((await scanned).rows[0].id).toBe(id);
      await scanning.query("commit");
    } finally {
      hangUp(reopening, scanning);
    }
    expect(await openOn(r.tableId)).toEqual([id]);
  });

  it("a scan that opened and closed a session after the reopen's transaction began still refuses it", async () => {
    const r = await orderingRestaurant(owner.db);
    const id = await aSession(r, { opened: 60, closed: 5 });
    const reopening = await aTenant(r.restaurantId);
    try {
      await reopening.query("select 1");
      const { rows } = await owner.db.execute<{ id: string }>(sql`
        insert into table_sessions (restaurant_id, table_id) values (${r.restaurantId}, ${r.tableId}) returning id`);
      await owner.db.execute(sql`
        update table_sessions set status = 'closed', closed_at = now(), close_reason = 'staff_clear' where id = ${rows[0].id}`);

      expect(await outcome(reopening.query(REOPEN, [id]))).toBe(NEWER);
      await reopening.query("rollback");
    } finally {
      hangUp(reopening);
    }
    expect(await openOn(r.tableId)).toEqual([]);
  });
});
