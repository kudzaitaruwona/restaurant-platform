import { eq, sql, type SQLWrapper } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auditLog, diningTables, tableSessions } from "@/db/schema";
import {
  openOwnerDatabase,
  openSystemDatabase,
  testDatabaseSettings,
} from "../../test/integration/database";
import { orderingRestaurant } from "../../test/integration/ordering";
import { lastSessionOf, reopening, reopenSession, sessionToReopen } from "./closing";
import { closeSessions } from "./cron/idle-expiry";
import { getTableDetail } from "./floor";
import { joinTableSession } from "./ordering";

/**
 * Reopening a closed session from the floor view (spec 06, Sessions; #76), as
 * app_tenant: staff only, within 15 minutes of the close, and only if no session
 * has opened on the table since. Postgres holds the rule (trigger
 * table_sessions_reopen, tested straight at Postgres in
 * src/db/session-reopen.int.test.ts); this is the staff action on top of it and
 * what the table's detail offers. Who's asking is a context handed in:
 * access.int.test.ts has the real seam.
 */
const owner = openOwnerDatabase();
const system = openSystemDatabase();
beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});
afterAll(async () => {
  await Promise.all([owner.pool.end(), system.pool.end()]);
  vi.unstubAllEnvs();
});

type Restaurant = Awaited<ReturnType<typeof orderingRestaurant>>;

const ctx = (r: Restaurant) => ({ restaurantId: r.restaurantId, staffId: r.staffId, role: "staff" as const });

/**
 * A session on the table, opened `opened` minutes ago and closed `closed`
 * minutes ago by staff, or still open when `closed` is null. Minutes on
 * Postgres's clock, which is the one the rule reads.
 */
async function aSession(
  r: Restaurant,
  { opened, closed, idle = closed ?? 0 }: { opened: number; closed: number | null; idle?: number },
) {
  const { rows } = await owner.db.execute<{ id: string }>(sql`
    insert into table_sessions (restaurant_id, table_id, status, opened_at, last_activity_at, closed_at, close_reason, closed_by)
    values (
      ${r.restaurantId}, ${r.tableId}, ${closed === null ? "open" : "closed"},
      now() - make_interval(secs => ${opened * 60}), now() - make_interval(secs => ${idle * 60}),
      ${closed === null ? null : sql`now() - make_interval(secs => ${closed * 60})`},
      ${closed === null ? null : "staff_clear"}, ${closed === null ? null : r.staffId})
    returning id`);
  return rows[0].id;
}

const sessionRow = async (id: string) =>
  (await owner.db.select().from(tableSessions).where(eq(tableSessions.id, id)))[0];
const auditOf = (r: Restaurant) =>
  owner.db.select().from(auditLog).where(eq(auditLog.restaurantId, r.restaurantId));
const openOn = async (tableId: string) =>
  (await owner.db.select().from(tableSessions).where(eq(tableSessions.tableId, tableId)))
    .filter((s) => s.status === "open")
    .map((s) => s.id);

describe("reopen", () => {
  it("reopens a session closed 14 minutes ago: open, the close forgotten, active now, and audited with who", async () => {
    const r = await orderingRestaurant(owner.db);
    const id = await aSession(r, { opened: 120, closed: 14, idle: 20 });
    const { closedAt } = await sessionRow(id);
    const before = Date.now();

    expect(await reopenSession(ctx(r), r.tableId, id)).toEqual({ outcome: "done" });

    const row = await sessionRow(id);
    expect(row).toMatchObject({ status: "open", closedAt: null, closeReason: null, closedBy: null });
    expect(row.lastActivityAt.getTime()).toBeGreaterThanOrEqual(before - 5_000);
    expect(await auditOf(r)).toEqual([
      expect.objectContaining({
        actorType: "staff",
        actorId: r.staffId,
        action: "session.reopen",
        entityType: "table_session",
        entityId: id,
        details: { closedAt: closedAt!.toISOString(), closeReason: "staff_clear" },
      }),
    ]);
  });

  it("is audited as the platform admin for an entered admin (S-28), reopened by the shadow row", async () => {
    const r = await orderingRestaurant(owner.db);
    const id = await aSession(r, { opened: 60, closed: 2 });
    const platformAdminId = crypto.randomUUID();

    expect(await reopenSession({ ...ctx(r), platformAdminId }, r.tableId, id)).toEqual({ outcome: "done" });
    expect(await auditOf(r)).toEqual([
      expect.objectContaining({ actorType: "platform_admin", actorId: platformAdminId, action: "session.reopen" }),
    ]);
  });

  it("is refused at 16 minutes, changes nothing and writes no audit entry", async () => {
    const r = await orderingRestaurant(owner.db);
    const id = await aSession(r, { opened: 120, closed: 16 });

    expect(await reopenSession(ctx(r), r.tableId, id)).toEqual({ outcome: "too_late" });
    expect((await sessionRow(id)).status).toBe("closed");
    expect(await auditOf(r)).toEqual([]);
  });

  it.each([
    ["is still there", null],
    ["has already closed", 2],
  ] as const)("is refused if a new party has opened the table since and %s", async (_how, closed) => {
    const r = await orderingRestaurant(owner.db);
    const id = await aSession(r, { opened: 60, closed: 10 });
    await aSession(r, { opened: 8, closed });

    expect(await reopenSession(ctx(r), r.tableId, id)).toEqual({ outcome: "superseded" });
    expect((await sessionRow(id)).status).toBe("closed");
    expect(await auditOf(r)).toEqual([]);
  });

  it("is a session_changed for a session that is open already, unknown, or another table's", async () => {
    const r = await orderingRestaurant(owner.db);
    const open = await aSession(r, { opened: 5, closed: null });
    const [{ id: otherTable }] = await owner.db
      .insert(diningTables)
      .values({ restaurantId: r.restaurantId, label: "Table 8", capacity: 2, qrToken: crypto.randomUUID().replaceAll("-", "").slice(0, 22) })
      .returning({ id: diningTables.id });

    expect(await reopenSession(ctx(r), r.tableId, open)).toEqual({ outcome: "session_changed" });
    expect(await reopenSession(ctx(r), r.tableId, crypto.randomUUID())).toEqual({ outcome: "session_changed" });
    expect(await reopenSession(ctx(r), otherTable, open)).toEqual({ outcome: "session_changed" });
    expect(await auditOf(r)).toEqual([]);
  });

  it("is not found for another restaurant's table, an unknown one or an archived one, and changes nothing", async () => {
    const mine = await orderingRestaurant(owner.db);
    const theirs = await orderingRestaurant(owner.db);
    const theirSession = await aSession(theirs, { opened: 30, closed: 2 });

    expect(await reopenSession(ctx(mine), theirs.tableId, theirSession)).toEqual({ outcome: "not_found" });
    expect(await reopenSession(ctx(mine), crypto.randomUUID(), theirSession)).toEqual({ outcome: "not_found" });
    expect((await sessionRow(theirSession)).status).toBe("closed");

    const mySession = await aSession(mine, { opened: 30, closed: 2 });
    await owner.db.update(diningTables).set({ archivedAt: new Date() }).where(eq(diningTables.id, mine.tableId));
    expect(await reopenSession(ctx(mine), mine.tableId, mySession)).toEqual({ outcome: "not_found" });
    expect((await sessionRow(mySession)).status).toBe("closed");
  });

  it("two reopens at once: one reopens, the other finds it open already, and one audit entry", async () => {
    const r = await orderingRestaurant(owner.db);
    const id = await aSession(r, { opened: 60, closed: 3 });

    const outcomes = await Promise.all([
      reopenSession(ctx(r), r.tableId, id),
      reopenSession(ctx(r), r.tableId, id),
    ]);

    expect(outcomes.map((o) => o.outcome).sort()).toEqual(["done", "session_changed"]);
    expect(await auditOf(r)).toHaveLength(1);
  });
});

describe("a reopen racing a scan of the same table", () => {
  // src/db/session-reopen.int.test.ts pins each order on the locks; this runs
  // the two real actions at once, both ways round, and checks the outcome agrees.
  it("has exactly one winner, and the other gets a clear answer: never two open sessions", async () => {
    for (let round = 0; round < 6; round++) {
      const r = await orderingRestaurant(owner.db);
      const id = await aSession(r, { opened: 60, closed: 3 });

      const [reopened, scanned] =
        round % 2 === 0
          ? await Promise.all([reopenSession(ctx(r), r.tableId, id), joinTableSession(r.qrToken)])
          : await Promise.all([joinTableSession(r.qrToken), reopenSession(ctx(r), r.tableId, id)]).then(
              ([s, o]) => [o, s] as const,
            );

      const open = await openOn(r.tableId);
      expect(open).toHaveLength(1);
      if (reopened.outcome === "done") {
        // The scan joined the reopened session.
        expect(scanned?.sessionId).toBe(id);
      } else {
        // The scan opened a new party's session first: the reopen is a clear refusal.
        expect(reopened).toEqual({ outcome: "superseded" });
        expect(scanned?.sessionId).not.toBe(id);
        expect(open).toEqual([scanned?.sessionId]);
      }
    }
  });
});

describe("a reopened session and idle expiry", () => {
  it("a session idle expiry closed, reopened, isn't closed again by the job's next run", async () => {
    const r = await orderingRestaurant(owner.db);
    const control = await orderingRestaurant(owner.db);
    // Idle for 100 minutes, as the job would find it.
    const id = await aSession(r, { opened: 150, closed: null, idle: 100 });
    const stillIdle = await aSession(control, { opened: 150, closed: null, idle: 100 });

    // The job closes it, with its own close, keyed to this session only: a run
    // over every restaurant at today's time would close other files' sessions.
    const run = new Date();
    expect(await system.db.transaction((tx) => closeSessions(tx, [{ restaurantId: r.restaurantId, id }], run))).toBe(1);
    expect(await sessionRow(id)).toMatchObject({ status: "closed", closeReason: "idle_expiry" });

    expect(await reopenSession(ctx(r), r.tableId, id)).toEqual({ outcome: "done" });

    // The next run, 5 minutes on, closes the session that is still idle and not the reopened one.
    const next = new Date(run.getTime() + 5 * 60_000);
    const due = [
      { restaurantId: r.restaurantId, id },
      { restaurantId: control.restaurantId, id: stillIdle },
    ];
    expect(await system.db.transaction((tx) => closeSessions(tx, due, next))).toBe(1);
    expect((await sessionRow(id)).status).toBe("open");
    expect((await sessionRow(stillIdle)).status).toBe("closed");
  });
});

describe("what the table's detail offers", () => {
  it("a session closed within the last 15 minutes, with when and how it closed", async () => {
    const r = await orderingRestaurant(owner.db);
    const id = await aSession(r, { opened: 60, closed: 14 });
    const { closedAt } = await sessionRow(id);

    const detail = await getTableDetail(ctx(r), r.tableId);

    expect(detail?.session).toBeNull();
    expect(detail?.reopenable).toEqual({ id, closedAt, closeReason: "staff_clear" });
  });

  it("nothing once the 15 minutes have passed", async () => {
    const r = await orderingRestaurant(owner.db);
    await aSession(r, { opened: 60, closed: 16 });

    expect((await getTableDetail(ctx(r), r.tableId))?.reopenable).toBeNull();
  });

  it("nothing once a new party has opened the table, whether it is still there or has gone", async () => {
    const r = await orderingRestaurant(owner.db);
    await aSession(r, { opened: 60, closed: 10 });
    const newer = await aSession(r, { opened: 8, closed: null });

    const seated = await getTableDetail(ctx(r), r.tableId);
    expect(seated?.session?.id).toBe(newer);
    expect(seated?.reopenable).toBeNull();

    await owner.db.execute(sql`
      update table_sessions set status = 'closed', closed_at = now() - interval '20 minutes', close_reason = 'staff_clear'
      where id = ${newer}`);
    expect((await getTableDetail(ctx(r), r.tableId))?.reopenable).toBeNull();
  });

  it("nothing on a table that has never had a session", async () => {
    const r = await orderingRestaurant(owner.db);
    expect((await getTableDetail(ctx(r), r.tableId))?.reopenable).toBeNull();
  });
});

type Transaction = Parameters<Parameters<typeof owner.db.transaction>[0]>[0];

type PlanNode = {
  "Node Type": string;
  "Relation Name"?: string;
  "Actual Rows": number;
  "Actual Loops": number;
  "Rows Removed by Filter"?: number;
  "Rows Removed by Index Recheck"?: number;
  Plans?: PlanNode[];
};
const nodesOf = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodesOf)];
/** The rows a plan read from table_sessions, kept or filtered out, over every loop (as closing.int.test.ts counts). */
const sessionsRead = (plan: PlanNode) =>
  nodesOf(plan)
    .filter((node) => node["Relation Name"] === "table_sessions")
    .reduce((sum, node) => {
      const kept =
        node["Actual Rows"] + (node["Rows Removed by Filter"] ?? 0) + (node["Rows Removed by Index Recheck"] ?? 0);
      const indexed = (node.Plans ?? [])
        .flatMap(nodesOf)
        .filter((child) => child["Node Type"] === "Bitmap Index Scan")
        .reduce((entries, child) => entries + child["Actual Loops"] * child["Actual Rows"], 0);
      return sum + Math.max(node["Actual Loops"] * kept, indexed);
    }, 0);
const explain = async (tx: Transaction, query: SQLWrapper) => {
  const { rows } = await tx.execute<{ "QUERY PLAN": [{ Plan: PlanNode }] }>(
    sql`explain (analyze, format json) ${query}`,
  );
  return rows[0]["QUERY PLAN"][0].Plan;
};

/**
 * Every row and index entry of table_sessions this transaction has read so far,
 * by any scan: the table's sequential reads and each of its indexes' entries.
 * What a trigger reads doesn't show in an EXPLAIN of the statement that fired
 * it, so the reopen's own probe is measured this way.
 */
const sessionReadsSoFar = async (tx: Transaction) => {
  const { rows } = await tx.execute<{ read: number }>(sql`
    select sum(pg_stat_get_xact_tuples_returned(c.oid))::int as read
    from pg_class c
    where c.oid = 'table_sessions'::regclass
       or c.oid in (select indexrelid from pg_index where indrelid = 'table_sessions'::regclass)`);
  return rows[0].read;
};

describe("reopening, at a table with months of history", () => {
  // Sessions are never deleted, so a busy table piles them up. Neither what the
  // detail offers nor the reopen's "has a party opened this table since" may
  // read that table's past, as app_tenant, under RLS, on statistics as they
  // stand (before autovacuum has looked at the history) or fresh. The history is
  // on the same restaurant and table as the session under test. Run in a
  // transaction that is rolled back.
  it("reads the table's latest session and the one it reopens, and none of the history", async () => {
    const r = await orderingRestaurant(owner.db);
    const id = await aSession(r, { opened: 60, closed: 5 });

    const measured: { stats: string; last?: string; offer: number; lookup: PlanNode; reopen: number }[] = [];
    await owner.db
      .transaction(async (tx) => {
        // 2,000 closed sessions on this table over the past weeks, before this one opened.
        await tx.execute(sql`
          insert into table_sessions (restaurant_id, table_id, status, opened_at, last_activity_at, closed_at, close_reason)
          select ${r.restaurantId}, ${r.tableId}, 'closed', o, o + interval '40 minutes', o + interval '45 minutes', 'staff_clear'
          from generate_series(1, 2000) g, lateral (select now() - interval '30 days' + g * interval '20 minutes' as o) t`);
        for (const stats of ["as they stand", "analyzed"]) {
          if (stats === "analyzed") await tx.execute(sql`analyze table_sessions`);
          await tx.execute(sql`savepoint measure`);
          await tx.execute(sql`set local role app_tenant`);
          await tx.execute(sql`select set_config('app.restaurant_id', ${r.restaurantId}, true)`);
          let before = await sessionReadsSoFar(tx);
          const [last] = await lastSessionOf(tx, ctx(r), r.tableId);
          const offer = (await sessionReadsSoFar(tx)) - before;
          const lookup = await explain(tx, sessionToReopen(tx, id));
          before = await sessionReadsSoFar(tx);
          await reopening(tx, id);
          const reopen = (await sessionReadsSoFar(tx)) - before;
          measured.push({ stats, last: last?.id, offer, lookup, reopen });
          await tx.execute(sql`rollback to savepoint measure`);
        }
        tx.rollback();
      })
      .catch((error: unknown) => {
        if (measured.length < 2) throw error;
      });

    for (const { stats, last, offer, lookup, reopen } of measured) {
      // Upper bounds, not a pinned plan. Walking the table's history is 2,000 reads.
      expect(last, stats).toBe(id);
      // The latest entry of table_sessions_table_opened, then that session by its key: a
      // handful of entries, counting the versions the first round's rolled-back reopen
      // left in the indexes.
      expect(offer, stats).toBeGreaterThan(0);
      expect(offer, stats).toBeLessThanOrEqual(10);
      expect({ stats, rows: lookup["Actual Rows"] }).toEqual({ stats, rows: 1 });
      expect(sessionsRead(lookup), stats).toBeLessThanOrEqual(2);
      // The UPDATE's own lookup by id, the trigger's probe for a newer session
      // (which finds only the session itself), and the table lock's uniqueness
      // check: a handful of entries.
      expect(reopen, stats).toBeGreaterThan(0);
      expect(reopen, stats).toBeLessThanOrEqual(10);
    }
  });
});
