import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auditLog, orderItems, orders, tableSessions } from "@/db/schema";
import { openOwnerDatabase, testDatabaseSettings } from "../../test/integration/database";
import { orderingRestaurant } from "../../test/integration/ordering";
import { getBoard, getChanges } from "./kitchen";
import { getTableDetail } from "./floor";
import { rejectOrder, voidItem } from "./voids";

/**
 * Staff's override for D-01 (S-36, #73) against Postgres, as app_tenant: void
 * one item, or reject an order, each with a reason. Who's asking is a context
 * handed in: access.int.test.ts has the real seam.
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
    .values({ restaurantId: r.restaurantId, tableId: r.tableId, lastActivityAt: LONG_AGO })
    .returning({ id: tableSessions.id });
  return id;
}

const LONG_AGO = new Date("2020-01-01T10:00:00Z");

/** An order of lines in the given statuses, written as the owner role. */
async function ordered(r: Restaurant, statuses: Status[]) {
  const sessionId = await sessionOf(r);
  const [{ id: orderId }] = await owner.db
    .insert(orders)
    .values({ restaurantId: r.restaurantId, sessionId, customerName: "Tariro" })
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
        quantity: 1,
        unitPriceUsd: "8",
        status,
        ...(status === "voided" ? { voidReason: "First reason", voidedBy: r.staffId } : {}),
      })
      .returning({ id: orderItems.id });
    ids.push(id);
  }
  await owner.db.update(tableSessions).set({ lastActivityAt: LONG_AGO }).where(eq(tableSessions.id, sessionId));
  return { sessionId, orderId, ids };
}

const lines = (ids: string[]) =>
  owner.db
    .select()
    .from(orderItems)
    .where(inArray(orderItems.id, ids))
    .then((rows) => ids.map((id) => rows.find((row) => row.id === id)!));
const sessionRow = async (id: string) =>
  (await owner.db.select().from(tableSessions).where(eq(tableSessions.id, id)))[0];
const auditOf = (r: Restaurant) =>
  owner.db.select().from(auditLog).where(eq(auditLog.restaurantId, r.restaurantId));

describe("voiding an item", () => {
  it.each(["placed", "cooking", "done"] as const)(
    "voids a %s item with who voided it and why, and bumps the session's activity",
    async (status) => {
      const r = await orderingRestaurant(owner.db);
      const { ids, sessionId } = await ordered(r, [status, "placed"]);

      expect(await voidItem(ctx(r), ids[0], "Nobody at the table")).toEqual({ outcome: "done" });

      const [line, other] = await lines(ids);
      expect(line).toMatchObject({ status: "voided", voidReason: "Nobody at the table", voidedBy: r.staffId });
      expect(line.statusChangedAt.getTime()).toBeGreaterThan(LONG_AGO.getTime());
      expect(other.status).toBe("placed");
      expect((await sessionRow(sessionId)).lastActivityAt.getTime()).toBeGreaterThan(LONG_AGO.getTime());
    },
  );

  it("is audited as order_item.void with the staff member, the item and the reason", async () => {
    const r = await orderingRestaurant(owner.db);
    const { ids, orderId } = await ordered(r, ["cooking"]);

    await voidItem(ctx(r), ids[0], "Nobody at the table");

    expect(await auditOf(r)).toEqual([
      expect.objectContaining({
        actorType: "staff",
        actorId: r.staffId,
        action: "order_item.void",
        entityType: "order_item",
        entityId: ids[0],
        details: { orderId, from: "cooking", reason: "Nobody at the table" },
      }),
    ]);
  });

  it("records an entered platform admin as one in the audit log, and the shadow staff row on the item (S-29)", async () => {
    const r = await orderingRestaurant(owner.db);
    const { ids } = await ordered(r, ["placed"]);
    const platformAdminId = crypto.randomUUID();

    await voidItem({ ...ctx(r), platformAdminId }, ids[0], "Test order");

    expect((await lines(ids))[0].voidedBy).toBe(r.staffId);
    expect(await auditOf(r)).toEqual([
      expect.objectContaining({ actorType: "platform_admin", actorId: platformAdminId, action: "order_item.void" }),
    ]);
  });

  it.each(["delivered", "voided"] as const)(
    "refuses a %s item, saying what it is, and changes nothing",
    async (status) => {
      const r = await orderingRestaurant(owner.db);
      const { ids, sessionId } = await ordered(r, [status]);
      const [before] = await lines(ids);

      expect(await voidItem(ctx(r), ids[0], "Second thoughts")).toEqual({ outcome: "wrong_status", status });

      expect((await lines(ids))[0]).toEqual(before);
      expect((await sessionRow(sessionId)).lastActivityAt).toEqual(LONG_AGO);
      expect(await auditOf(r)).toEqual([]);
    },
  );

  it("is not found for another restaurant's item or an unknown one, and changes nothing", async () => {
    const mine = await orderingRestaurant(owner.db);
    const theirs = await orderingRestaurant(owner.db);
    const { ids } = await ordered(theirs, ["placed"]);

    expect(await voidItem(ctx(mine), ids[0], "Not mine")).toEqual({ outcome: "not_found" });
    expect(await voidItem(ctx(mine), crypto.randomUUID(), "Unknown")).toEqual({ outcome: "not_found" });
    expect((await lines(ids))[0].status).toBe("placed");
  });

  it("leaves the kitchen board on the next poll, and shows as voided in the table's detail", async () => {
    const r = await orderingRestaurant(owner.db);
    const { ids } = await ordered(r, ["placed", "cooking"]);
    const { cursor } = await getBoard(ctx(r));

    await voidItem(ctx(r), ids[0], "Nobody at the table");

    const changes = await getChanges(ctx(r), cursor);
    expect(changes.items.find((item) => item.id === ids[0])?.status).toBe("voided");
    expect((await getBoard(ctx(r))).items.map((item) => item.id)).toEqual([ids[1]]);
    const detail = await getTableDetail(ctx(r), r.tableId);
    expect(detail?.orders[0].items.find((item) => item.id === ids[0])?.status).toBe("voided");
  });

  it("two voids at once: one wins, the other is refused, and the first reason stays", async () => {
    const r = await orderingRestaurant(owner.db);
    const { ids } = await ordered(r, ["placed"]);

    const outcomes = await Promise.all([
      voidItem(ctx(r), ids[0], "Reason one"),
      voidItem(ctx(r), ids[0], "Reason two"),
    ]);

    expect(outcomes.map((o) => o.outcome).sort()).toEqual(["done", "wrong_status"]);
    expect(await auditOf(r)).toHaveLength(1);
    expect(["Reason one", "Reason two"]).toContain((await lines(ids))[0].voidReason);
  });
});

describe("rejecting an order", () => {
  it("voids every undelivered item with one reason; delivered items stay, and voided ones keep their first reason", async () => {
    const r = await orderingRestaurant(owner.db);
    const { ids, orderId, sessionId } = await ordered(r, ["placed", "cooking", "done", "delivered", "voided"]);

    expect(await rejectOrder(ctx(r), orderId, "Nobody at the table")).toEqual({
      outcome: "done",
      voided: ids.slice(0, 3).sort(),
    });

    const after = await lines(ids);
    expect(after.map((line) => line.status)).toEqual(["voided", "voided", "voided", "delivered", "voided"]);
    for (const line of after.slice(0, 3)) {
      expect(line).toMatchObject({ voidReason: "Nobody at the table", voidedBy: r.staffId });
    }
    expect(after[3]).toMatchObject({ voidReason: null, voidedBy: null });
    expect(after[4].voidReason).toBe("First reason");
    expect((await sessionRow(sessionId)).lastActivityAt.getTime()).toBeGreaterThan(LONG_AGO.getTime());
  });

  it("leaves the session's other orders alone, and the order leaves the kitchen board", async () => {
    const r = await orderingRestaurant(owner.db);
    const rejected = await ordered(r, ["placed", "cooking"]);
    const kept = await ordered(r, ["placed"]);

    await rejectOrder(ctx(r), rejected.orderId, "Nobody at the table");

    expect((await lines(kept.ids))[0].status).toBe("placed");
    expect((await getBoard(ctx(r))).items.map((item) => item.id)).toEqual(kept.ids);
  });

  it("is audited as order.reject, and order_item.void for each item it voided", async () => {
    const r = await orderingRestaurant(owner.db);
    const { ids, orderId } = await ordered(r, ["placed", "delivered", "voided"]);

    await rejectOrder(ctx(r), orderId, "Nobody at the table");

    const entries = await auditOf(r);
    expect(entries).toHaveLength(2);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorType: "staff",
          actorId: r.staffId,
          action: "order.reject",
          entityType: "order",
          entityId: orderId,
          details: { reason: "Nobody at the table", voided: [ids[0]] },
        }),
        expect.objectContaining({
          actorType: "staff",
          actorId: r.staffId,
          action: "order_item.void",
          entityType: "order_item",
          entityId: ids[0],
          details: { orderId, from: "placed", reason: "Nobody at the table" },
        }),
      ]),
    );
  });

  it("refuses an order with nothing left to void, and changes nothing", async () => {
    const r = await orderingRestaurant(owner.db);
    const { ids, orderId, sessionId } = await ordered(r, ["delivered", "voided"]);
    const before = await lines(ids);

    expect(await rejectOrder(ctx(r), orderId, "Too late")).toEqual({ outcome: "nothing_to_void" });

    expect(await lines(ids)).toEqual(before);
    expect((await sessionRow(sessionId)).lastActivityAt).toEqual(LONG_AGO);
    expect(await auditOf(r)).toEqual([]);
  });

  it("is not found for another restaurant's order or an unknown one, and changes nothing", async () => {
    const mine = await orderingRestaurant(owner.db);
    const theirs = await orderingRestaurant(owner.db);
    const { ids, orderId } = await ordered(theirs, ["placed"]);

    expect(await rejectOrder(ctx(mine), orderId, "Not mine")).toEqual({ outcome: "not_found" });
    expect(await rejectOrder(ctx(mine), crypto.randomUUID(), "Unknown")).toEqual({ outcome: "not_found" });
    expect((await lines(ids))[0].status).toBe("placed");
  });

  it("is one transaction: when the audit entry can't be written, no item is voided", async () => {
    const r = await orderingRestaurant(owner.db);
    const { ids, orderId, sessionId } = await ordered(r, ["placed", "cooking"]);

    // audit_log.actor_id is a uuid, so this actor's entry fails after the items were updated.
    await expect(
      rejectOrder({ ...ctx(r), platformAdminId: "not-a-uuid" }, orderId, "Nobody at the table"),
    ).rejects.toThrow();

    expect((await lines(ids)).map((line) => line.status)).toEqual(["placed", "cooking"]);
    expect((await sessionRow(sessionId)).lastActivityAt).toEqual(LONG_AGO);
    expect(await auditOf(r)).toEqual([]);
  });
});
