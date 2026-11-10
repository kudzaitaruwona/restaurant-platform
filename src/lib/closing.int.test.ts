import { and, eq, inArray, sql, type SQLWrapper } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auditLog, diningTables, orderItems, orders, tableSessions } from "@/db/schema";
import { openOwnerDatabase, testDatabaseSettings } from "../../test/integration/database";
import { orderingRestaurant } from "../../test/integration/ordering";
import { POST as joinSession } from "@/app/api/t/[qrToken]/session/route";
import { GET as track } from "@/app/api/t/[qrToken]/tracker/route";
import { clearTable, forceCloseTable, openSessionOf, outstandingLines } from "./closing";

/**
 * Closing a table's session from the floor view (spec 06, Sessions; #74), as
 * app_tenant: clear table, and force-close. Who's asking is a context handed in:
 * access.int.test.ts has the real seam. The closure gate itself is tested
 * straight at Postgres in src/db/closure-gate.int.test.ts.
 */
const owner = openOwnerDatabase();
beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});
afterAll(async () => {
  await owner.pool.end();
  vi.unstubAllEnvs();
});

type Restaurant = Awaited<ReturnType<typeof orderingRestaurant>>;
type Status = (typeof orderItems.$inferSelect)["status"];

const ctx = (r: Restaurant) => ({ restaurantId: r.restaurantId, staffId: r.staffId, role: "staff" as const });

async function sessionOf(r: Restaurant) {
  const [open] = await owner.db
    .select({ id: tableSessions.id })
    .from(tableSessions)
    .where(and(eq(tableSessions.tableId, r.tableId), eq(tableSessions.status, "open")));
  if (open) return open.id;
  const [{ id }] = await owner.db
    .insert(tableSessions)
    .values({ restaurantId: r.restaurantId, tableId: r.tableId })
    .returning({ id: tableSessions.id });
  return id;
}

/** An order of lines in the given statuses on the table's open session, written as the owner role. */
async function ordered(r: Restaurant, statuses: Status[], customerName = "Tariro") {
  const sessionId = await sessionOf(r);
  const [{ id: orderId }] = await owner.db
    .insert(orders)
    .values({ restaurantId: r.restaurantId, sessionId, customerName })
    .returning({ id: orders.id });
  const ids: string[] = [];
  for (const status of statuses) {
    const [{ id }] = await owner.db
      .insert(orderItems)
      .values({
        restaurantId: r.restaurantId,
        orderId,
        menuItemId: r.itemId,
        nameSnapshot: "Beef stew",
        quantity: 2,
        unitPriceUsd: "8",
        status,
        ...(status === "voided" ? { voidReason: "First reason", voidedBy: r.staffId } : {}),
      })
      .returning({ id: orderItems.id });
    ids.push(id);
  }
  return { sessionId, orderId, ids };
}

const sessionRow = async (id: string) =>
  (await owner.db.select().from(tableSessions).where(eq(tableSessions.id, id)))[0];
const lines = (ids: string[]) =>
  owner.db
    .select()
    .from(orderItems)
    .where(inArray(orderItems.id, ids))
    .then((rows) => ids.map((id) => rows.find((row) => row.id === id)!));
const auditOf = (r: Restaurant) =>
  owner.db.select().from(auditLog).where(eq(auditLog.restaurantId, r.restaurantId));

describe("clear table", () => {
  it("closes a session whose items are all delivered or voided, with staff_clear, who and when", async () => {
    const r = await orderingRestaurant(owner.db);
    const { sessionId } = await ordered(r, ["delivered", "voided"]);
    const before = Date.now();

    expect(await clearTable(ctx(r), r.tableId, sessionId)).toEqual({ outcome: "done" });

    const row = await sessionRow(sessionId);
    expect(row).toMatchObject({ status: "closed", closeReason: "staff_clear", closedBy: r.staffId });
    expect(row.closedAt!.getTime()).toBeGreaterThanOrEqual(before - 5_000);
  });

  it("closes a session nobody ordered in", async () => {
    const r = await orderingRestaurant(owner.db);
    const sessionId = await sessionOf(r);

    expect(await clearTable(ctx(r), r.tableId, sessionId)).toEqual({ outcome: "done" });
    expect((await sessionRow(sessionId)).status).toBe("closed");
  });

  it("is refused while any item is placed, cooking or done, listing those items, and changes nothing", async () => {
    const r = await orderingRestaurant(owner.db);
    const first = await ordered(r, ["delivered", "placed"], "Tariro");
    const second = await ordered(r, ["cooking", "voided", "done"], "Farai");

    // Oldest order first; within an order, by id.
    const farai = [
      { id: second.ids[0], name: "Beef stew", quantity: 2, status: "cooking", customerName: "Farai" },
      { id: second.ids[2], name: "Beef stew", quantity: 2, status: "done", customerName: "Farai" },
    ].sort((a, b) => a.id.localeCompare(b.id));
    expect(await clearTable(ctx(r), r.tableId, first.sessionId)).toEqual({
      outcome: "blocked",
      items: [{ id: first.ids[1], name: "Beef stew", quantity: 2, status: "placed", customerName: "Tariro" }, ...farai],
    });
    expect((await sessionRow(first.sessionId)).status).toBe("open");
  });

  it("isn't audited for staff (spec 01's list leaves it out), but is for an entered platform admin (S-28)", async () => {
    const staffClears = await orderingRestaurant(owner.db);
    await clearTable(ctx(staffClears), staffClears.tableId, await sessionOf(staffClears));
    expect(await auditOf(staffClears)).toEqual([]);

    const adminClears = await orderingRestaurant(owner.db);
    const sessionId = await sessionOf(adminClears);
    const platformAdminId = crypto.randomUUID();
    await clearTable({ ...ctx(adminClears), platformAdminId }, adminClears.tableId, sessionId);
    expect(await auditOf(adminClears)).toEqual([
      expect.objectContaining({
        actorType: "platform_admin",
        actorId: platformAdminId,
        action: "session.clear",
        entityType: "table_session",
        entityId: sessionId,
      }),
    ]);
    expect((await sessionRow(sessionId)).closedBy).toBe(adminClears.staffId);
  });

  it("is refused when the table's open session isn't the one the page showed: none now, or a new party's", async () => {
    const r = await orderingRestaurant(owner.db);
    const shown = await sessionOf(r);
    expect(await clearTable(ctx(r), r.tableId, shown)).toEqual({ outcome: "done" });
    // A second tap, or a colleague's: the session is gone.
    expect(await clearTable(ctx(r), r.tableId, shown)).toEqual({ outcome: "session_changed" });

    // A new party has scanned since: the old page's tap must not close their session.
    const next = await sessionOf(r);
    expect(await clearTable(ctx(r), r.tableId, shown)).toEqual({ outcome: "session_changed" });
    expect((await sessionRow(next)).status).toBe("open");
  });

  it("is not found for another restaurant's table, an archived one or an unknown one, and closes nothing", async () => {
    const mine = await orderingRestaurant(owner.db);
    const theirs = await orderingRestaurant(owner.db);
    const theirSession = await sessionOf(theirs);

    expect(await clearTable(ctx(mine), theirs.tableId, theirSession)).toEqual({ outcome: "not_found" });
    expect(await clearTable(ctx(mine), crypto.randomUUID(), theirSession)).toEqual({ outcome: "not_found" });
    expect((await sessionRow(theirSession)).status).toBe("open");

    const archived = await orderingRestaurant(owner.db);
    const archivedSession = await sessionOf(archived);
    await owner.db.update(diningTables).set({ archivedAt: new Date() }).where(eq(diningTables.id, archived.tableId));
    expect(await clearTable(ctx(archived), archived.tableId, archivedSession)).toEqual({ outcome: "not_found" });
  });

  it("clears the waiter call with the session", async () => {
    const r = await orderingRestaurant(owner.db);
    const sessionId = await sessionOf(r);
    await owner.db.update(tableSessions).set({ waiterRequestedAt: new Date() }).where(eq(tableSessions.id, sessionId));

    await clearTable(ctx(r), r.tableId, sessionId);

    expect((await sessionRow(sessionId)).waiterRequestedAt).toBeNull();
  });
});

describe("force-close", () => {
  it("voids every outstanding item with the staff member and reason, then closes with force_close", async () => {
    const r = await orderingRestaurant(owner.db);
    const first = await ordered(r, ["placed", "delivered", "voided"]);
    const second = await ordered(r, ["cooking", "done"]);

    const result = await forceCloseTable(ctx(r), r.tableId, first.sessionId, "Party walked out");

    expect(result).toEqual({ outcome: "done", voided: [first.ids[0], ...second.ids].sort() });
    const after = await lines([...first.ids, ...second.ids]);
    expect(after.map((line) => line.status)).toEqual(["voided", "delivered", "voided", "voided", "voided"]);
    for (const line of [after[0], after[3], after[4]]) {
      expect(line).toMatchObject({ voidReason: "Party walked out", voidedBy: r.staffId });
    }
    expect(after[2].voidReason).toBe("First reason");
    expect(after[1]).toMatchObject({ voidReason: null, voidedBy: null });
    expect(await sessionRow(first.sessionId)).toMatchObject({
      status: "closed",
      closeReason: "force_close",
      closedBy: r.staffId,
    });
  });

  it("is audited as session.force_close with the reason and the items it voided, and order_item.void for each", async () => {
    const r = await orderingRestaurant(owner.db);
    const { sessionId, orderId, ids } = await ordered(r, ["placed", "delivered"]);

    await forceCloseTable(ctx(r), r.tableId, sessionId, "Party walked out");

    const entries = await auditOf(r);
    expect(entries).toHaveLength(2);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorType: "staff",
          actorId: r.staffId,
          action: "session.force_close",
          entityType: "table_session",
          entityId: sessionId,
          details: { reason: "Party walked out", voided: [ids[0]] },
        }),
        expect.objectContaining({
          actorType: "staff",
          actorId: r.staffId,
          action: "order_item.void",
          entityId: ids[0],
          details: { orderId, from: "placed", reason: "Party walked out" },
        }),
      ]),
    );
  });

  it("records an entered platform admin as one, and the shadow staff row on the session and items (S-29)", async () => {
    const r = await orderingRestaurant(owner.db);
    const { sessionId, ids } = await ordered(r, ["placed"]);
    const platformAdminId = crypto.randomUUID();

    await forceCloseTable({ ...ctx(r), platformAdminId }, r.tableId, sessionId, "Test order");

    expect((await lines(ids))[0].voidedBy).toBe(r.staffId);
    expect((await sessionRow(sessionId)).closedBy).toBe(r.staffId);
    const entries = await auditOf(r);
    expect(entries.map((entry) => [entry.actorType, entry.actorId])).toEqual([
      ["platform_admin", platformAdminId],
      ["platform_admin", platformAdminId],
    ]);
  });

  it("closes a session with nothing outstanding too, voiding nothing", async () => {
    const r = await orderingRestaurant(owner.db);
    const { sessionId } = await ordered(r, ["delivered"]);

    expect(await forceCloseTable(ctx(r), r.tableId, sessionId, "End of night")).toEqual({
      outcome: "done",
      voided: [],
    });
    expect((await sessionRow(sessionId)).closeReason).toBe("force_close");
  });

  it("is one transaction: when the audit can't be written, nothing is voided and the session stays open", async () => {
    const r = await orderingRestaurant(owner.db);
    const { sessionId, ids } = await ordered(r, ["placed", "cooking"]);

    // audit_log.actor_id is a uuid, so this actor's entries fail after the items were updated.
    await expect(
      forceCloseTable({ ...ctx(r), platformAdminId: "not-a-uuid" }, r.tableId, sessionId, "Walked out"),
    ).rejects.toThrow();

    expect((await lines(ids)).map((line) => line.status)).toEqual(["placed", "cooking"]);
    expect((await sessionRow(sessionId)).status).toBe("open");
  });

  it("doesn't put the reason in a thrown error's message", async () => {
    const r = await orderingRestaurant(owner.db);
    const { sessionId } = await ordered(r, ["placed"]);

    const error = await forceCloseTable(
      { ...ctx(r), platformAdminId: "not-a-uuid" },
      r.tableId,
      sessionId,
      "Secret reason",
    ).catch((e: Error) => e);

    expect(String((error as Error).message)).not.toContain("Secret reason");
  });

  it("is refused for a changed session, and not found for another restaurant's table, changing nothing", async () => {
    const r = await orderingRestaurant(owner.db);
    const { ids } = await ordered(r, ["placed"]);
    expect(await forceCloseTable(ctx(r), r.tableId, crypto.randomUUID(), "Stale")).toEqual({
      outcome: "session_changed",
    });

    const theirs = await orderingRestaurant(owner.db);
    const theirOrder = await ordered(theirs, ["placed"]);
    expect(await forceCloseTable(ctx(r), theirs.tableId, theirOrder.sessionId, "Not mine")).toEqual({
      outcome: "not_found",
    });
    expect((await lines([...ids, ...theirOrder.ids])).map((line) => line.status)).toEqual(["placed", "placed"]);
    expect((await sessionRow(theirOrder.sessionId)).status).toBe("open");
    expect(await auditOf(r)).toEqual([]);
  });

  it("two force-closes at once: one closes, the other finds the session gone", async () => {
    const r = await orderingRestaurant(owner.db);
    const { sessionId } = await ordered(r, ["placed", "cooking"]);

    const outcomes = await Promise.all([
      forceCloseTable(ctx(r), r.tableId, sessionId, "Reason one"),
      forceCloseTable(ctx(r), r.tableId, sessionId, "Reason two"),
    ]);

    expect(outcomes.map((o) => o.outcome).sort()).toEqual(["done", "session_changed"]);
    expect((await auditOf(r)).filter((entry) => entry.action === "session.force_close")).toHaveLength(1);
  });
});

describe("after a close", () => {
  const params = (qrToken: string) => ({ params: Promise.resolve({ qrToken }) });
  const join = async (qrToken: string) =>
    (await (await joinSession(new Request("http://localhost/x", { method: "POST" }), params(qrToken))).json())
      .session as string;
  const tracker = async (qrToken: string) =>
    (await track(new Request(`http://localhost/api/t/${qrToken}/tracker`), params(qrToken))).json();

  it.each(["clear", "force-close"] as const)(
    "%s: the customer's tracker has no session (the page says it has ended), and the next scan opens a new one",
    async (how) => {
      const r = await orderingRestaurant(owner.db);
      const joined = await join(r.qrToken);
      await ordered(r, [how === "clear" ? "delivered" : "cooking"]);
      expect((await tracker(r.qrToken)).session).toBe(joined);

      const result =
        how === "clear"
          ? await clearTable(ctx(r), r.tableId, joined)
          : await forceCloseTable(ctx(r), r.tableId, joined, "Walked out");
      expect(result.outcome).toBe("done");

      expect(await tracker(r.qrToken)).toEqual({ session: null, items: [] });
      const fresh = await join(r.qrToken);
      expect(fresh).not.toBe(joined);
      expect(await tracker(r.qrToken)).toEqual({ session: fresh, items: [] });
    },
  );
});

type Transaction = Parameters<Parameters<typeof owner.db.transaction>[0]>[0];

/**
 * `sessions` closed sessions of history on the restaurant's table, each of 3
 * orders of `linesPerOrder` delivered lines, as kitchen.int.test.ts and
 * floor.int.test.ts write it, with triggers off (session_replication_role).
 */
async function history(tx: Transaction, r: Restaurant, { sessions, linesPerOrder }: { sessions: number; linesPerOrder: number }) {
  await tx.execute(sql`set local session_replication_role = replica`);
  await tx.execute(sql`
    with s as (
      insert into table_sessions (restaurant_id, table_id, status, closed_at, close_reason)
      select ${r.restaurantId}, ${r.tableId}, 'closed', now(), 'idle_expiry'
      from generate_series(1, ${sessions})
      returning restaurant_id, id
    ), o as (
      insert into orders (restaurant_id, session_id, customer_name)
      select s.restaurant_id, s.id, 'Guest' from s, generate_series(1, 3)
      returning restaurant_id, id
    )
    insert into order_items (restaurant_id, order_id, menu_item_id, name_snapshot, quantity, unit_price_usd, status)
    select o.restaurant_id, o.id, ${r.itemId}, 'Beef stew', 1, 8, 'delivered'
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
/** The rows a plan read from a table, kept or filtered out, over every loop (as floor.int.test.ts counts). */
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
const readsOf = (plan: PlanNode) =>
  Object.fromEntries(
    (["table_sessions", "orders", "order_items"] as const).map((table) => [table, rowsRead(plan, table)]),
  );

describe("closing, at a restaurant with months of history", () => {
  // Sessions, orders and lines are never deleted, so finding the table's open
  // session and its outstanding lines must not read the history, as app_tenant,
  // under RLS, once Postgres has statistics. Both closes send these two reads;
  // the EXPLAINs run in a transaction that is rolled back.
  it("reads the open session and its own orders and lines, and none of the history", async () => {
    const r = await orderingRestaurant(owner.db);
    const neighbour = await orderingRestaurant(owner.db);
    const first = await ordered(r, ["placed", "delivered"]);
    await ordered(r, ["cooking", "voided"]);

    let plans: { session: PlanNode; lines: PlanNode } | undefined;
    await owner.db
      .transaction(async (tx) => {
        await history(tx, r, { sessions: 1000, linesPerOrder: 1 });
        await history(tx, neighbour, { sessions: 1000, linesPerOrder: 9 });
        await tx.execute(sql`analyze order_items, orders, table_sessions`);
        await tx.execute(sql`set local role app_tenant`);
        await tx.execute(sql`select set_config('app.restaurant_id', ${r.restaurantId}, true)`);
        plans = {
          session: await explain(tx, openSessionOf(tx, ctx(r), r.tableId)),
          lines: await explain(tx, outstandingLines(tx, ctx(r), first.sessionId)),
        };
        tx.rollback();
      })
      .catch((error: unknown) => {
        if (plans === undefined) throw error;
      });

    expect(readsOf(plans!.session)).toEqual({ table_sessions: 1, orders: 0, order_items: 0 });
    // Two orders of two lines each: the open session's own, and nothing more.
    expect(plans!.lines["Actual Rows"]).toBe(2);
    // Upper bounds, not a pinned plan: the planner may join orders -> lines (2 + 4 reads) or
    // read the in-play lines first and probe orders (2 + 2); both are fine. Walking history
    // (~3,000 orders or ~30,000 lines) is what must fail.
    const reads = readsOf(plans!.lines);
    expect(reads.table_sessions).toBe(0);
    expect(reads.orders).toBeLessThanOrEqual(2);
    expect(reads.order_items).toBeLessThanOrEqual(4);
  });
});
