import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auditLog, diningTables, orderItems, orders, tableSessions } from "@/db/schema";
import { openOwnerDatabase, testDatabaseSettings } from "../../test/integration/database";
import { orderingRestaurant } from "../../test/integration/ordering";
import { getFloor, getTableDetail, markItemDelivered } from "./floor";

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

  it("is audited only for a platform admin, like the other actions spec 01 leaves off its list", async () => {
    const r = await orderingRestaurant(owner.db);
    const { ids } = await order(r, [{ status: "done" }, { status: "done" }]);
    const platformAdminId = crypto.randomUUID();

    await markItemDelivered(ctx(r), ids[0]);
    expect(await owner.db.select().from(auditLog).where(eq(auditLog.restaurantId, r.restaurantId))).toEqual([]);

    await markItemDelivered({ ...ctx(r), platformAdminId }, ids[1]);
    expect(await owner.db.select().from(auditLog).where(eq(auditLog.restaurantId, r.restaurantId))).toEqual([
      expect.objectContaining({
        action: "order_item.deliver",
        entityType: "order_item",
        entityId: ids[1],
        actorType: "platform_admin",
        actorId: platformAdminId,
      }),
    ]);
  });
});
