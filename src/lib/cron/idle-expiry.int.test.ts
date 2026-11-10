import { eq, sql, type SQLWrapper } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auditLog, diningTables, orderItems, orders, tableSessions } from "@/db/schema";
import { placeOrder } from "@/lib/ordering";
import {
  openOwnerDatabase,
  openSystemDatabase,
  openTestDatabase,
  testDatabaseSettings,
} from "../../../test/integration/database";
import { orderingRestaurant } from "../../../test/integration/ordering";
import { closeIdleSessions, closeSessions, closing, idleSessions } from "./idle-expiry";

/**
 * Spec 06's idle expiry, run by the scheduled job (S-35) as app_system: an open
 * session with no activity for 90 minutes closes, unless an item is still in
 * play, in which case it stays open and the floor flags it (src/lib/floor.ts).
 * The job works across every restaurant, so like the other job tests this picks
 * its own "now" and lives in a year no other file uses, 1985: no other test's
 * session was last active that early, so running the job here can't close a
 * session another file is looking at.
 */
const owner = openOwnerDatabase();
const system = openSystemDatabase();
const app = openTestDatabase();
beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});
afterAll(async () => {
  await Promise.all([owner.pool.end(), system.pool.end(), app.pool.end()]);
  vi.unstubAllEnvs();
});

const NOW = new Date("1985-06-01T18:00:00Z");
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);

type Restaurant = Awaited<ReturnType<typeof orderingRestaurant>>;
type Status = (typeof orderItems.$inferSelect)["status"];

/**
 * An open session, last active `idle` minutes before NOW, with an order of lines
 * in the given statuses: on a restaurant of its own, or on a new table of `at`.
 */
async function aSession(
  statuses: Status[],
  { idle, openedFor = idle, at }: { idle: number; openedFor?: number; at?: Restaurant },
) {
  const r = at ?? (await orderingRestaurant(owner.db));
  const tableId = at
    ? (
        await owner.db
          .insert(diningTables)
          .values({
            restaurantId: at.restaurantId,
            label: `Table ${crypto.randomUUID().slice(0, 8)}`,
            capacity: 4,
            qrToken: crypto.randomUUID().replaceAll("-", "").slice(0, 22),
          })
          .returning({ id: diningTables.id })
      )[0].id
    : r.tableId;
  const [{ id: sessionId }] = await owner.db
    .insert(tableSessions)
    .values({
      restaurantId: r.restaurantId,
      tableId,
      openedAt: minutesAgo(openedFor),
      lastActivityAt: minutesAgo(idle),
    })
    .returning({ id: tableSessions.id });
  let orderId: string | undefined;
  if (statuses.length > 0) {
    [{ id: orderId }] = await owner.db
      .insert(orders)
      .values({ restaurantId: r.restaurantId, sessionId, customerName: "Tariro" })
      .returning({ id: orders.id });
    for (const status of statuses) {
      await owner.db.insert(orderItems).values({
        restaurantId: r.restaurantId,
        orderId,
        menuItemId: r.itemId,
        nameSnapshot: "Beef stew",
        quantity: 1,
        unitPriceUsd: "8",
        status,
        ...(status === "voided" ? { voidReason: "Sent back", voidedBy: r.staffId } : {}),
      });
    }
  }
  return { r, sessionId, orderId };
}

const sessionRow = async (id: string) =>
  (await owner.db.select().from(tableSessions).where(eq(tableSessions.id, id)))[0];

describe("idle expiry", () => {
  it("closes a fully delivered session 90 minutes after its last activity, not 90 minutes after it opened", async () => {
    const active = await aSession(["delivered"], { idle: 30, openedFor: 180 });
    const almost = await aSession(["delivered"], { idle: 89, openedFor: 180 });
    const idle = await aSession(["delivered", "voided"], { idle: 90, openedFor: 95 });

    expect(await closeIdleSessions(system.db, NOW)).toBeGreaterThanOrEqual(1);

    expect((await sessionRow(active.sessionId)).status).toBe("open");
    expect((await sessionRow(almost.sessionId)).status).toBe("open");
    expect(await sessionRow(idle.sessionId)).toMatchObject({
      status: "closed",
      closeReason: "idle_expiry",
      closedBy: null,
      closedAt: NOW,
      lastActivityAt: minutesAgo(90),
    });
  });

  it("closes an idle session nobody ordered in, and ends a waiter call with it", async () => {
    const { sessionId } = await aSession([], { idle: 120 });
    await owner.db
      .update(tableSessions)
      .set({ waiterRequestedAt: minutesAgo(120) })
      .where(eq(tableSessions.id, sessionId));

    await closeIdleSessions(system.db, NOW);

    expect(await sessionRow(sessionId)).toMatchObject({ status: "closed", waiterRequestedAt: null });
  });

  it.each(["placed", "cooking", "done"] as const)(
    "skips an idle session with an item still %s, and still closes the others in the same run",
    async (status) => {
      const blocked = await aSession(["delivered", status], { idle: 240 });
      const due = await aSession(["delivered"], { idle: 100 });

      // Not refused mid-run: the run succeeds and does the rest of its work.
      await expect(closeIdleSessions(system.db, NOW)).resolves.toBeGreaterThanOrEqual(1);

      expect((await sessionRow(blocked.sessionId)).status).toBe("open");
      expect((await sessionRow(due.sessionId)).status).toBe("closed");
    },
  );

  it("isn't audited: close_reason records it", async () => {
    const { r, sessionId } = await aSession(["delivered"], { idle: 100 });

    await closeIdleSessions(system.db, NOW);

    expect((await sessionRow(sessionId)).status).toBe("closed");
    expect(await owner.db.select().from(auditLog).where(eq(auditLog.restaurantId, r.restaurantId))).toEqual([]);
  });

  it("closes nothing again when run again", async () => {
    const { sessionId } = await aSession(["delivered"], { idle: 100 });
    await closeIdleSessions(system.db, NOW);
    const closed = await sessionRow(sessionId);

    expect(await closeIdleSessions(system.db, NOW)).toBe(0);
    expect(await sessionRow(sessionId)).toEqual(closed);
  });

  it("two runs at once close each session once", async () => {
    // Whatever an earlier run of this file left due is swept first, so the count is exact.
    await closeIdleSessions(system.db, NOW);
    const sessions = await Promise.all(
      Array.from({ length: 6 }, () => aSession(["delivered"], { idle: 100 })),
    );

    const [first, second] = await Promise.all([
      closeIdleSessions(system.db, NOW),
      closeIdleSessions(system.db, NOW),
    ]);

    expect(first + second).toBe(sessions.length);
    for (const { sessionId } of sessions) {
      expect(await sessionRow(sessionId)).toMatchObject({ status: "closed", closedAt: NOW });
    }
  });

  it("stops once its time budget is spent", async () => {
    const { sessionId } = await aSession(["delivered"], { idle: 100 });

    expect(await closeIdleSessions(system.db, NOW, { budgetMs: 0 })).toBe(0);
    expect((await sessionRow(sessionId)).status).toBe("open");

    await closeIdleSessions(system.db, NOW);
  });
});

describe("idle expiry and an order arriving at the same moment", () => {
  it("an order in first keeps the session open: the job passes over it rather than wait", async () => {
    const { r, sessionId, orderId } = await aSession(["delivered"], { idle: 100 });
    // placeOrder's shape: take the session's row to mark it active, then add a line.
    const ordering = await app.pool.connect();
    try {
      await ordering.query("begin");
      await ordering.query("select set_config('app.restaurant_id', $1, true)", [r.restaurantId]);
      await ordering.query(
        "update table_sessions set last_activity_at = now() where table_id = $1 and status = 'open'",
        [r.tableId],
      );
      await ordering.query(
        `insert into order_items (restaurant_id, order_id, menu_item_id, name_snapshot, quantity, unit_price_usd)
         values ($1, $2, $3, 'Beef stew', 1, 8)`,
        [r.restaurantId, orderId, r.itemId],
      );

      await closeIdleSessions(system.db, NOW);
      expect((await sessionRow(sessionId)).status).toBe("open");

      await ordering.query("commit");
    } finally {
      ordering.release(true);
    }
    expect((await sessionRow(sessionId)).status).toBe("open");
    const lines = await owner.db.select().from(orderItems).where(eq(orderItems.orderId, orderId!));
    expect(lines.map((line) => line.status).sort()).toEqual(["delivered", "placed"]);
  });

  it("a close in first makes the order wait, and the order is then refused because the session closed", async () => {
    const { r, sessionId } = await aSession(["delivered"], { idle: 100 });

    let order: ReturnType<typeof placeOrder> | undefined;
    await system.db.transaction(async (tx) => {
      // The job's two steps, in its transaction, with the order arriving between them.
      const due = await idleSessions(tx, NOW);
      expect(due).toContainEqual({ restaurantId: r.restaurantId, id: sessionId });
      const [{ pid }] = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows;

      order = placeOrder(r.qrToken, {
        session: sessionId,
        name: "Latecomer",
        lines: [{ item: r.itemId, quantity: 1, note: null }],
      });
      await vi.waitFor(
        async () => {
          const { rows } = await owner.db.execute(sql`
            select 1 from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`);
          expect(rows).toHaveLength(1);
        },
        { timeout: 5_000, interval: 20 },
      );

      expect(await closeSessions(tx, due, NOW)).toBeGreaterThanOrEqual(1);
    });

    expect(await order).toEqual({ outcome: "session_changed" });
    expect((await sessionRow(sessionId)).status).toBe("closed");
    const lines = await owner.db
      .select({ status: orderItems.status })
      .from(orderItems)
      .where(eq(orderItems.restaurantId, r.restaurantId));
    expect(lines).toEqual([{ status: "delivered" }]);
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
/** The rows a plan read from a table, kept or filtered out, over every loop (as closing.int.test.ts counts). */
const rowsRead = (plan: PlanNode, table: string) =>
  nodesOf(plan)
    .filter((node) => node["Relation Name"] === table)
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
 * `sessions` closed sessions of history on the restaurant's table, last active
 * long before NOW (so only their status keeps the job off them), each of 3
 * orders of 3 delivered lines, written with triggers off as closing.int.test.ts
 * writes its history.
 */
async function history(tx: Transaction, r: Restaurant, sessions: number) {
  await tx.execute(sql`set local session_replication_role = replica`);
  await tx.execute(sql`
    with s as (
      insert into table_sessions (restaurant_id, table_id, status, opened_at, last_activity_at, closed_at, close_reason)
      select ${r.restaurantId}, ${r.tableId}, 'closed', '1980-01-01', '1980-01-01', '1980-01-01', 'idle_expiry'
      from generate_series(1, ${sessions})
      returning restaurant_id, id
    ), o as (
      insert into orders (restaurant_id, session_id, customer_name)
      select s.restaurant_id, s.id, 'Guest' from s, generate_series(1, 3)
      returning restaurant_id, id
    )
    insert into order_items (restaurant_id, order_id, menu_item_id, name_snapshot, quantity, unit_price_usd, status)
    select o.restaurant_id, o.id, ${r.itemId}, 'Beef stew', 1, 8, 'delivered'
    from o, generate_series(1, 3)`);
  await tx.execute(sql`set local session_replication_role = origin`);
}

describe("idle expiry, across restaurants with months of history", () => {
  // Sessions, orders and lines are never deleted, so the job must find the open
  // sessions without reading the closed ones, and check each one's lines without
  // reading anyone's history. It runs as app_system, which bypasses RLS. EXPLAINed
  // in a transaction that is rolled back.
  //
  // The history (2,000 sessions, 6,000 orders and 18,000 lines) is on the same
  // restaurant as a due session and a blocked one, so the job's check of each
  // runs against it: a probe of that restaurant's orders or lines, rather than
  // the session's, would read thousands of rows. Both the batch's SELECT and the
  // close's UPDATE are EXPLAINed, first on the statistics as they stand (the plan
  // a cron run actually gets between autovacuum's analyzes), then after an
  // ANALYZE that sees the history.
  //
  // Upper bounds, not a pinned plan. The test database is shared and never
  // emptied, so the live rows every plan may read (the open sessions, their
  // orders and lines, the lines in play) are counted in the EXPLAIN's own
  // snapshot, and a margin is allowed for them.
  it("reads the open sessions and their orders and lines, and none of the closed history", async () => {
    const r = await orderingRestaurant(owner.db);
    const due = await aSession(["delivered"], { idle: 100, at: r });
    const blocked = await aSession(["delivered", "placed"], { idle: 100, at: r });
    const checked = [
      { restaurantId: r.restaurantId, id: due.sessionId },
      { restaurantId: r.restaurantId, id: blocked.sessionId },
    ];

    type Found = { stats: string; query: string; plan: PlanNode };
    const found: Found[] = [];
    let live: Record<string, number> | undefined;
    let closed: Record<string, string>[] = [];
    await owner.db
      .transaction(async (tx) => {
        // One snapshot for the live counts and every EXPLAIN. Serializable, not
        // repeatable read: the closure gate refuses a close under repeatable read.
        await tx.execute(sql`set transaction isolation level serializable`);
        await history(tx, r, 2000);
        [live] = (
          await tx.execute<Record<string, number>>(sql`
            select
              (select count(*)::int from table_sessions where status = 'open') as table_sessions,
              (select count(*)::int from orders o join table_sessions s
                 on s.restaurant_id = o.restaurant_id and s.id = o.session_id where s.status = 'open') as orders,
              (select count(*)::int from order_items i join orders o
                 on o.restaurant_id = i.restaurant_id and o.id = i.order_id
                 join table_sessions s on s.restaurant_id = o.restaurant_id and s.id = o.session_id
                 where s.status = 'open') + (select count(*)::int from order_items where in_play) as order_items`)
        ).rows;

        for (const stats of ["as they stand", "analyzed"]) {
          if (stats === "analyzed") await tx.execute(sql`analyze order_items, orders, table_sessions`);
          // The UPDATE runs, so it runs in a savepoint and is undone before the next EXPLAIN.
          await tx.execute(sql`savepoint explained`);
          await tx.execute(sql`set local role app_system`);
          found.push({ stats, query: "batch", plan: await explain(tx, idleSessions(tx, NOW)) });
          found.push({ stats, query: "close", plan: await explain(tx, closing(tx, checked, NOW).getSQL()) });
          await tx.execute(sql`reset role`);
          if (stats === "analyzed") {
            closed = (
              await tx.execute<Record<string, string>>(sql`
                select id, status from table_sessions
                where restaurant_id = ${r.restaurantId} and status = 'open' and table_id <> ${r.tableId}`)
            ).rows;
          }
          await tx.execute(sql`rollback to savepoint explained`);
        }
        tx.rollback();
      })
      .catch((error: unknown) => {
        if (found.length < 4) throw error;
      });

    // The close got the answer right: the delivered session closed, the blocked one stayed open.
    expect(closed).toEqual([{ id: blocked.sessionId, status: "open" }]);
    const margin = 300;
    for (const { stats, query, plan } of found) {
      if (query === "batch") expect(plan["Actual Rows"], `${query}, stats ${stats}`).toBeGreaterThanOrEqual(1);
      for (const table of ["table_sessions", "orders", "order_items"]) {
        expect(rowsRead(plan, table), `${query} reads ${table}, stats ${stats}`).toBeLessThanOrEqual(
          live![table] + margin,
        );
      }
    }
  });
});
