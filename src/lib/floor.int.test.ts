import { and, eq, sql, type SQLWrapper } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auditLog, diningTables, orderItems, orders, tableSessions } from "@/db/schema";
import { openOwnerDatabase, testDatabaseSettings } from "../../test/integration/database";
import { orderingRestaurant } from "../../test/integration/ordering";
import {
  dismissWaiter,
  floorCounts,
  floorTables,
  getFloor,
  getTableDetail,
  markItemDelivered,
} from "./floor";

const owner = openOwnerDatabase();
beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});
afterAll(async () => {
  await owner.pool.end();
  vi.unstubAllEnvs();
});

type Restaurant = Awaited<ReturnType<typeof orderingRestaurant>>;

/** An order of lines on a table, opening its session if it has none. Written as the owner role. */
async function order(
  restaurant: Restaurant,
  lines: (Partial<typeof orderItems.$inferInsert> & { name?: string })[],
  { tableId = restaurant.tableId, customerName = "Tariro" } = {},
) {
  const [open] = await owner.db
    .select()
    .from(tableSessions)
    .where(and(eq(tableSessions.tableId, tableId), eq(tableSessions.status, "open")));
  const session =
    open ??
    (
      await owner.db
        .insert(tableSessions)
        .values({ restaurantId: restaurant.restaurantId, tableId })
        .returning()
    )[0];
  const [{ id: orderId }] = await owner.db
    .insert(orders)
    .values({ restaurantId: restaurant.restaurantId, sessionId: session.id, customerName })
    .returning({ id: orders.id });
  const ids: string[] = [];
  for (const { name = "Beef stew", ...line } of lines) {
    const [{ id }] = await owner.db
      .insert(orderItems)
      .values({
        restaurantId: restaurant.restaurantId,
        orderId,
        menuItemId: restaurant.itemId,
        nameSnapshot: name,
        quantity: 1,
        unitPriceUsd: "8",
        ...line,
      })
      .returning({ id: orderItems.id });
    ids.push(id);
  }
  return { sessionId: session.id, orderId, ids };
}

const addTable = async (restaurant: Restaurant, label: string, sortOrder: number, extra = {}) => {
  const [{ id }] = await owner.db
    .insert(diningTables)
    .values({
      restaurantId: restaurant.restaurantId,
      label,
      capacity: 2,
      sortOrder,
      qrToken: crypto.randomUUID().replaceAll("-", "").slice(0, 22),
      ...extra,
    })
    .returning({ id: diningTables.id });
  return id;
};

const ctx = (restaurant: Restaurant) => ({
  restaurantId: restaurant.restaurantId,
  staffId: restaurant.staffId,
  role: "staff" as const,
});

describe("the floor grid", () => {
  it("lists live tables in sort order, free or open, leaving out archived ones", async () => {
    const r = await orderingRestaurant(owner.db);
    await owner.db.update(diningTables).set({ sortOrder: 5 }).where(eq(diningTables.id, r.tableId));
    const first = await addTable(r, "Bar 1", 1);
    await addTable(r, "Gone", 2, { archivedAt: new Date() });
    await order(r, [{}]);

    const { tables } = await getFloor(ctx(r));

    expect(tables.map((t) => [t.label, t.status])).toEqual([
      ["Bar 1", "free"],
      ["Table 7", "open"],
    ]);
    expect(tables[0].id).toBe(first);
    expect(tables[0].openedAt).toBeNull();
  });

  it("counts placed, cooking, done and delivered items of the open session, leaving out voided ones", async () => {
    const r = await orderingRestaurant(owner.db);
    await order(r, [
      { status: "placed" },
      { status: "placed", quantity: 3 },
      { status: "cooking" },
      { status: "done" },
      { status: "delivered" },
    ]);
    // A line is counted once however many were ordered; a void is not counted at all.
    await order(r, [{ status: "voided", voidReason: "Wrong table", voidedBy: r.staffId }]);

    const [table] = (await getFloor(ctx(r))).tables;

    expect(table.counts).toEqual({ placed: 2, cooking: 1, done: 1, delivered: 1 });
  });

  it("counts only the open session, not an earlier party's closed one", async () => {
    const r = await orderingRestaurant(owner.db);
    const { sessionId, ids } = await order(r, [{ status: "delivered" }]);
    await owner.db
      .update(tableSessions)
      .set({ status: "closed", closedAt: new Date(), closeReason: "staff_clear" })
      .where(eq(tableSessions.id, sessionId));
    expect(ids).toHaveLength(1);

    const [table] = (await getFloor(ctx(r))).tables;

    expect(table.status).toBe("free");
    expect(table.counts).toEqual({ placed: 0, cooking: 0, done: 0, delivered: 0 });
  });

  it("gives when the session opened and the restaurant's timezone", async () => {
    const r = await orderingRestaurant(owner.db);
    const { sessionId } = await order(r, [{}]);
    const openedAt = new Date("2031-01-01T10:00:00Z");
    await owner.db.update(tableSessions).set({ openedAt }).where(eq(tableSessions.id, sessionId));

    const floor = await getFloor(ctx(r));

    expect(floor.timezone).toBe("Africa/Harare");
    expect(floor.tables[0].openedAt).toEqual(openedAt);
  });

  it("shows only its own restaurant's tables", async () => {
    const mine = await orderingRestaurant(owner.db);
    const theirs = await orderingRestaurant(owner.db);
    await addTable(theirs, "Theirs", 0);

    const { tables } = await getFloor(ctx(mine));

    expect(tables.map((t) => t.label)).toEqual(["Table 7"]);
  });
});

type Transaction = Parameters<Parameters<typeof owner.db.transaction>[0]>[0];

/**
 * `sessions` closed sessions of history on the restaurant's table, each of 3
 * orders of `linesPerOrder` delivered lines, as kitchen.int.test.ts writes it.
 * Triggers are off for it (session_replication_role): every row is written
 * already closed, as months of service would have left it.
 */
async function history(
  tx: Transaction,
  restaurant: Restaurant,
  { sessions, linesPerOrder }: { sessions: number; linesPerOrder: number },
) {
  await tx.execute(sql`set local session_replication_role = replica`);
  await tx.execute(sql`
    with s as (
      insert into table_sessions (restaurant_id, table_id, status, closed_at, close_reason)
      select ${restaurant.restaurantId}, ${restaurant.tableId}, 'closed', now(), 'idle_expiry'
      from generate_series(1, ${sessions})
      returning restaurant_id, id
    ), o as (
      insert into orders (restaurant_id, session_id, customer_name)
      select s.restaurant_id, s.id, 'Guest' from s, generate_series(1, 3)
      returning restaurant_id, id
    )
    insert into order_items (restaurant_id, order_id, menu_item_id, name_snapshot, quantity, unit_price_usd, status)
    select o.restaurant_id, o.id, ${restaurant.itemId}, 'Beef stew', 1, 8, 'delivered'
    from o, generate_series(1, ${linesPerOrder})`);
  await tx.execute(sql`set local session_replication_role = origin`);
}

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
/**
 * The rows a plan's nodes read from a table, kept or filtered out, over every
 * loop. A Bitmap Heap Scan reads at least the entries its Bitmap Index Scans
 * found, so a BitmapAnd that walks an index over the history and keeps a few
 * rows still counts the history it walked. EXPLAIN gives Actual Rows as a
 * rounded mean per loop, so a test keeps its loops even.
 */
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
const tablesIn = ["tables", "table_sessions", "orders", "order_items"] as const;
const readsOf = (plan: PlanNode) =>
  Object.fromEntries(tablesIn.map((table) => [table, rowsRead(plan, table)]));

describe("the floor grid, at a restaurant with months of history", () => {
  // Sessions, orders and lines are never deleted, so the grid must find the few
  // open sessions and their lines without reading the restaurant's history, as
  // app_tenant, under RLS, once Postgres has statistics. This EXPLAINs the two
  // reads getFloor sends, built by getFloor's own builders, in a transaction
  // that is rolled back. The rollback takes the history and pg_statistic with
  // it, but not the row counts ANALYZE writes to pg_class (those are updated in
  // place), so later plans see this table as larger than it is; the same
  // holds for kitchen.int.test.ts, which this mirrors.
  //
  // tables is the one read here that doesn't grow with history: it holds the
  // floors of every restaurant, and while it is small (a fresh test database
  // has a few dozen rows) Postgres rightly seq-scans it, whatever the order the
  // files ran in. So tables is bounded by its own size, read in the snapshot
  // the EXPLAIN runs in, and the history tables are held exactly.
  it("reads the live tables, their open sessions and those sessions' orders, and none of the history", async () => {
    const restaurant = await orderingRestaurant(owner.db);
    const neighbour = await orderingRestaurant(owner.db);
    // Every live table is open and every order has two lines: EXPLAIN gives a
    // scan's rows as a rounded mean per loop, so one session found over two
    // lookups would read as none, and uneven orders would miscount their lines.
    const bar = await addTable(restaurant, "Bar 1", 1);
    const live = await order(restaurant, [{ status: "placed" }, { status: "cooking" }]);
    await order(restaurant, [{ status: "done" }, { status: "delivered" }]);
    const atBar = await order(restaurant, [{ status: "placed" }, { status: "placed" }], { tableId: bar });

    let plans: { tables: PlanNode; counts: PlanNode; allTables: number } | undefined;
    await owner.db
      .transaction(async (tx) => {
        // One snapshot for the count and the EXPLAINs, though other files write tables meanwhile.
        await tx.execute(sql`set transaction isolation level repeatable read`);
        await history(tx, restaurant, { sessions: 1000, linesPerOrder: 1 });
        // Other restaurants have history too: this one is a tenth of the table.
        await history(tx, neighbour, { sessions: 1000, linesPerOrder: 9 });
        await tx.execute(sql`analyze order_items, orders, table_sessions, tables`);
        const allTables = await tx.$count(diningTables);
        await tx.execute(sql`set local role app_tenant`);
        await tx.execute(sql`select set_config('app.restaurant_id', ${restaurant.restaurantId}, true)`);
        const sessionIds = [live.sessionId, atBar.sessionId];
        plans = {
          allTables,
          tables: await explain(tx, floorTables(tx, restaurant)),
          counts: await explain(tx, floorCounts(tx, restaurant, sessionIds)),
        };
        tx.rollback();
      })
      .catch((error: unknown) => {
        if (plans === undefined) throw error;
      });

    // Two live tables, each with one open session; those have three orders of six lines.
    const { tables, ...historyReads } = readsOf(plans!.tables);
    expect(historyReads).toEqual({ table_sessions: 2, orders: 0, order_items: 0 });
    expect(tables).toBeGreaterThanOrEqual(2);
    expect(tables).toBeLessThanOrEqual(plans!.allTables);
    // One group per session and status: placed, cooking, done and delivered, and placed at the bar.
    expect(plans!.counts["Actual Rows"]).toBe(5);
    expect(readsOf(plans!.counts)).toEqual({ tables: 0, table_sessions: 0, orders: 3, order_items: 6 });
  });
});

describe("a table's detail", () => {
  it("has every order and item of the open session with customer name, note and status", async () => {
    const r = await orderingRestaurant(owner.db);
    await order(r, [{ name: "Beef stew", note: "No onions", status: "cooking" }, { name: "Sadza", status: "done" }], {
      customerName: "Tariro",
    });
    await order(r, [{ name: "Rice", status: "placed", quantity: 2 }], { customerName: "Farai" });

    const detail = await getTableDetail(ctx(r), r.tableId);

    expect(detail?.table.label).toBe("Table 7");
    expect(detail?.orders.map((o) => [o.customerName, o.items.map((i) => [i.name, i.quantity, i.note, i.status]).sort()])).toEqual([
      ["Tariro", [["Beef stew", 1, "No onions", "cooking"], ["Sadza", 1, null, "done"]]],
      ["Farai", [["Rice", 2, null, "placed"]]],
    ]);
  });

  it("is empty for a free table, and leaves out a closed session's orders", async () => {
    const r = await orderingRestaurant(owner.db);
    const { sessionId } = await order(r, [{ status: "delivered" }]);
    await owner.db
      .update(tableSessions)
      .set({ status: "closed", closedAt: new Date(), closeReason: "staff_clear" })
      .where(eq(tableSessions.id, sessionId));

    const detail = await getTableDetail(ctx(r), r.tableId);

    expect(detail?.session).toBeNull();
    expect(detail?.orders).toEqual([]);
  });

  it("is null for another restaurant's table, an unknown one and an archived one", async () => {
    const mine = await orderingRestaurant(owner.db);
    const theirs = await orderingRestaurant(owner.db);
    const archived = await addTable(mine, "Gone", 3, { archivedAt: new Date() });

    expect(await getTableDetail(ctx(mine), theirs.tableId)).toBeNull();
    expect(await getTableDetail(ctx(mine), crypto.randomUUID())).toBeNull();
    expect(await getTableDetail(ctx(mine), archived)).toBeNull();
  });
});

describe("marking an item delivered", () => {
  const stateOf = async (id: string) => {
    const [row] = await owner.db.select().from(orderItems).where(eq(orderItems.id, id));
    return row;
  };
  const activityOf = async (sessionId: string) =>
    (await owner.db.select().from(tableSessions).where(eq(tableSessions.id, sessionId)))[0];

  it("moves a done item to delivered and bumps the session's last activity in the same go", async () => {
    const r = await orderingRestaurant(owner.db);
    const { ids, sessionId } = await order(r, [{ status: "done" }]);
    const longAgo = new Date("2020-01-01T10:00:00Z");
    await owner.db.update(tableSessions).set({ lastActivityAt: longAgo }).where(eq(tableSessions.id, sessionId));

    expect(await markItemDelivered(ctx(r), ids[0])).toEqual({ outcome: "done" });

    expect((await stateOf(ids[0])).status).toBe("delivered");
    expect((await stateOf(ids[0])).statusChangedAt.getTime()).toBeGreaterThan(longAgo.getTime());
    expect((await activityOf(sessionId)).lastActivityAt.getTime()).toBeGreaterThan(longAgo.getTime());
  });

  it.each(["placed", "cooking", "delivered", "voided"] as const)(
    "refuses an item that is %s, saying what it is, and changes nothing",
    async (status) => {
      const r = await orderingRestaurant(owner.db);
      const { ids, sessionId } = await order(r, [
        { status, ...(status === "voided" ? { voidReason: "Mistake", voidedBy: r.staffId } : {}) },
      ]);
      const before = await activityOf(sessionId);

      expect(await markItemDelivered(ctx(r), ids[0])).toEqual({ outcome: "wrong_status", status });

      expect((await stateOf(ids[0])).status).toBe(status);
      expect(await activityOf(sessionId)).toEqual(before);
    },
  );

  it("is not found for another restaurant's item or an unknown one, and changes nothing", async () => {
    const mine = await orderingRestaurant(owner.db);
    const theirs = await orderingRestaurant(owner.db);
    const { ids } = await order(theirs, [{ status: "done" }]);

    expect(await markItemDelivered(ctx(mine), ids[0])).toEqual({ outcome: "not_found" });
    expect(await markItemDelivered(ctx(mine), crypto.randomUUID())).toEqual({ outcome: "not_found" });
    expect((await stateOf(ids[0])).status).toBe("done");
  });

  it("leaves the session open when the last item is delivered", async () => {
    const r = await orderingRestaurant(owner.db);
    const { ids, sessionId } = await order(r, [{ status: "delivered" }, { status: "done" }]);

    expect(await markItemDelivered(ctx(r), ids[1])).toEqual({ outcome: "done" });

    const session = await activityOf(sessionId);
    expect(session.status).toBe("open");
    expect(session.closedAt).toBeNull();
  });

  it("two taps at once have one winner and one 409", async () => {
    const r = await orderingRestaurant(owner.db);
    const { ids } = await order(r, [{ status: "done" }]);

    const outcomes = await Promise.all([markItemDelivered(ctx(r), ids[0]), markItemDelivered(ctx(r), ids[0])]);

    expect(outcomes.map((o) => o.outcome).sort()).toEqual(["done", "wrong_status"]);
  });

  it("is audited like every other status change, for staff and platform admin alike", async () => {
    const r = await orderingRestaurant(owner.db);
    const { ids } = await order(r, [{ status: "done" }, { status: "done" }]);
    const platformAdminId = crypto.randomUUID();

    await markItemDelivered(ctx(r), ids[0]);
    await markItemDelivered({ ...ctx(r), platformAdminId }, ids[1]);

    const entries = await owner.db.select().from(auditLog).where(eq(auditLog.restaurantId, r.restaurantId));
    expect(entries).toHaveLength(2);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "order_item.status",
          entityType: "order_item",
          entityId: ids[0],
          actorType: "staff",
          actorId: r.staffId,
          details: { from: "done", to: "delivered" },
        }),
        expect.objectContaining({
          action: "order_item.status",
          entityType: "order_item",
          entityId: ids[1],
          actorType: "platform_admin",
          actorId: platformAdminId,
          details: { from: "done", to: "delivered" },
        }),
      ]),
    );
  });

  it("writes no audit entry for a refused delivery", async () => {
    const r = await orderingRestaurant(owner.db);
    const { ids } = await order(r, [{ status: "cooking" }]);

    expect(await markItemDelivered(ctx(r), ids[0])).toEqual({ outcome: "wrong_status", status: "cooking" });

    expect(await owner.db.select().from(auditLog).where(eq(auditLog.restaurantId, r.restaurantId))).toEqual([]);
  });
});

describe("a table calling a waiter (spec 06, proposed)", () => {
  const calledAt = new Date("2031-01-01T10:05:00Z");
  const flag = (sessionId: string, at: Date | null = calledAt) =>
    owner.db.update(tableSessions).set({ waiterRequestedAt: at }).where(eq(tableSessions.id, sessionId));
  const waiterOf = async (sessionId: string) =>
    (await owner.db.select().from(tableSessions).where(eq(tableSessions.id, sessionId)))[0].waiterRequestedAt;

  it("shows on the grid and the detail: since when the open session has been calling", async () => {
    const r = await orderingRestaurant(owner.db);
    const quiet = await addTable(r, "Quiet", 9);
    const { sessionId } = await order(r, [{}]);
    await order(r, [{}], { tableId: quiet });
    await flag(sessionId);

    const { tables } = await getFloor(ctx(r));

    expect(tables.map((t) => [t.label, t.waiterRequestedAt])).toEqual([
      ["Table 7", calledAt],
      ["Quiet", null],
    ]);
    expect((await getTableDetail(ctx(r), r.tableId))?.session?.waiterRequestedAt).toEqual(calledAt);
  });

  it("is not shown on a free table", async () => {
    const r = await orderingRestaurant(owner.db);
    expect((await getFloor(ctx(r))).tables[0].waiterRequestedAt).toBeNull();
  });

  it("is dismissed by staff, clearing the flag and auditing who", async () => {
    const r = await orderingRestaurant(owner.db);
    const { sessionId } = await order(r, [{}]);
    await flag(sessionId);

    expect(await dismissWaiter(ctx(r), r.tableId)).toEqual({ outcome: "done" });

    expect(await waiterOf(sessionId)).toBeNull();
    expect(await owner.db.select().from(auditLog).where(eq(auditLog.restaurantId, r.restaurantId))).toEqual([
      expect.objectContaining({
        action: "table_session.waiter_dismiss",
        entityType: "table_session",
        entityId: sessionId,
        actorType: "staff",
        actorId: r.staffId,
      }),
    ]);
  });

  it("doesn't move the session's last activity: only the customer's call is activity", async () => {
    const r = await orderingRestaurant(owner.db);
    const { sessionId } = await order(r, [{}]);
    const longAgo = new Date("2020-01-01T10:00:00Z");
    await owner.db.update(tableSessions).set({ lastActivityAt: longAgo, waiterRequestedAt: calledAt }).where(eq(tableSessions.id, sessionId));

    await dismissWaiter(ctx(r), r.tableId);

    const [row] = await owner.db.select().from(tableSessions).where(eq(tableSessions.id, sessionId));
    expect(row.lastActivityAt).toEqual(longAgo);
  });

  it("dismissing a call nobody made, or twice, is fine and writes no audit entry", async () => {
    const r = await orderingRestaurant(owner.db);
    expect(await dismissWaiter(ctx(r), r.tableId)).toEqual({ outcome: "nothing_pending" });
    const { sessionId } = await order(r, [{}]);
    await flag(sessionId);
    const outcomes = await Promise.all([dismissWaiter(ctx(r), r.tableId), dismissWaiter(ctx(r), r.tableId)]);

    expect(outcomes.map((o) => o.outcome).sort()).toEqual(["done", "nothing_pending"]);
    expect(await owner.db.select().from(auditLog).where(eq(auditLog.restaurantId, r.restaurantId))).toHaveLength(1);
  });

  it("is not found for another restaurant's table, an archived one or an unknown one, and changes nothing", async () => {
    const mine = await orderingRestaurant(owner.db);
    const theirs = await orderingRestaurant(owner.db);
    const { sessionId } = await order(theirs, [{}]);
    await flag(sessionId);
    const archived = await addTable(mine, "Old", 3, { archivedAt: new Date() });

    for (const id of [theirs.tableId, archived, crypto.randomUUID()]) {
      expect(await dismissWaiter(ctx(mine), id)).toEqual({ outcome: "not_found" });
    }
    expect(await waiterOf(sessionId)).toEqual(calledAt);
  });
});
