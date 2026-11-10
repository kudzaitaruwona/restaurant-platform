import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auditLog, orderItems, orders, tableSessions } from "@/db/schema";
import { openOwnerDatabase, testDatabaseSettings } from "../../test/integration/database";
import { orderingRestaurant } from "../../test/integration/ordering";
import { getBoard, getChanges, moveItem } from "./kitchen";

/**
 * The kitchen board's reads and moves (spec 07) against Postgres, as app_tenant.
 * Who's asking is a context handed in: access.int.test.ts has the real seam.
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
const contextOf = (restaurant: Restaurant) => ({
  restaurantId: restaurant.restaurantId,
  staffId: restaurant.staffId,
  role: "staff" as const,
});

async function sessionOf(restaurant: Restaurant) {
  const [open] = await owner.db
    .select({ id: tableSessions.id })
    .from(tableSessions)
    .where(and(eq(tableSessions.tableId, restaurant.tableId), eq(tableSessions.status, "open")));
  if (open) return open.id;
  const [{ id }] = await owner.db
    .insert(tableSessions)
    .values({ restaurantId: restaurant.restaurantId, tableId: restaurant.tableId })
    .returning({ id: tableSessions.id });
  return id;
}

/** An order of one line, written as the owner role. */
async function ordered(
  restaurant: Restaurant,
  line: Partial<typeof orderItems.$inferInsert> & { customerName?: string } = {},
) {
  const { customerName = "Tariro", ...rest } = line;
  const sessionId = await sessionOf(restaurant);
  const [{ id: orderId }] = await owner.db
    .insert(orders)
    .values({ restaurantId: restaurant.restaurantId, sessionId, customerName })
    .returning({ id: orders.id });
  const [{ id }] = await owner.db
    .insert(orderItems)
    .values({
      restaurantId: restaurant.restaurantId,
      orderId,
      menuItemId: restaurant.itemId,
      nameSnapshot: "Beef stew",
      quantity: 2,
      unitPriceUsd: "8",
      ...rest,
    })
    .returning({ id: orderItems.id });
  return { id, orderId, sessionId };
}

const statusOfItem = async (id: string) =>
  (await owner.db.select({ status: orderItems.status }).from(orderItems).where(eq(orderItems.id, id)))[0]
    .status;

describe("the board", () => {
  it("has every placed, cooking and done item of its restaurant, and nothing delivered or voided", async () => {
    const restaurant = await orderingRestaurant(owner.db);
    const other = await orderingRestaurant(owner.db);
    const placed = await ordered(restaurant, { note: "No onions" });
    const cooking = await ordered(restaurant, { status: "cooking" });
    const done = await ordered(restaurant, { status: "done" });
    await ordered(restaurant, { status: "delivered" });
    await ordered(other);

    const board = await getBoard(contextOf(restaurant));

    expect(board.items.map((item) => item.id).sort()).toEqual(
      [placed.id, cooking.id, done.id].sort(),
    );
    expect(board.items.find((item) => item.id === placed.id)).toMatchObject({
      orderId: placed.orderId,
      table: "Table 7",
      quantity: 2,
      name: "Beef stew",
      note: "No onions",
      customerName: "Tariro",
      status: "placed",
    });
    expect(board.cursor).toMatch(/^\d+$/);
    expect(Math.abs(Date.parse(board.now) - Date.now())).toBeLessThan(60_000);
  });
});

describe("changes since a poll", () => {
  it("returns a new order and a moved item", async () => {
    const restaurant = await orderingRestaurant(owner.db);
    const still = await ordered(restaurant);
    const moved = await ordered(restaurant);
    const { cursor } = await getBoard(contextOf(restaurant));

    await moveItem(contextOf(restaurant), moved.id, "placed", "cooking");
    const added = await ordered(restaurant);
    const changes = await getChanges(contextOf(restaurant), cursor);

    const ids = changes.items.map((item) => item.id);
    expect(ids).toContain(added.id);
    expect(ids).toContain(moved.id);
    // A line that hasn't changed can come back while another transaction anywhere
    // in the database is still running (the cursor errs towards repeating), but
    // only as it was.
    expect(changes.items.filter((item) => item.id === still.id).map((item) => item.status)).not.toContain(
      "cooking",
    );
    expect(changes.items.find((item) => item.id === moved.id)?.status).toBe("cooking");
  });

  it("returns an item that left the board, so the board can drop it", async () => {
    const restaurant = await orderingRestaurant(owner.db);
    const leaving = await ordered(restaurant, { status: "done" });
    const { cursor } = await getBoard(contextOf(restaurant));

    await moveItem(contextOf(restaurant), leaving.id, "done", "delivered");

    const changes = await getChanges(contextOf(restaurant), cursor);
    expect(changes.items).toContainEqual(expect.objectContaining({ id: leaving.id, status: "delivered" }));
  });

  it("only ever returns its own restaurant's items", async () => {
    const restaurant = await orderingRestaurant(owner.db);
    const other = await orderingRestaurant(owner.db);
    const { cursor } = await getBoard(contextOf(restaurant));
    const theirs = await ordered(other);
    const mine = await ordered(restaurant);

    const ids = (await getChanges(contextOf(restaurant), cursor)).items.map((item) => item.id);

    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
  });

  it("can't miss a change committed after a poll's cutoff but stamped before it", async () => {
    const restaurant = await orderingRestaurant(owner.db);
    const item = await ordered(restaurant);
    const { cursor: first } = await getBoard(contextOf(restaurant));

    // A slow transaction moves the item and adds a line, stamping both with its
    // own start time, and is still open when the next poll runs.
    const slow = await owner.pool.connect();
    let late: string;
    try {
      await slow.query("begin");
      await slow.query("update order_items set status = 'cooking', status_changed_at = now() where id = $1", [
        item.id,
      ]);
      const inserted = await slow.query<{ id: string }>(
        `insert into order_items (restaurant_id, order_id, menu_item_id, name_snapshot, quantity, unit_price_usd)
         values ($1, $2, $3, 'Late stew', 1, 8) returning id`,
        [restaurant.restaurantId, item.orderId, restaurant.itemId],
      );
      late = inserted.rows[0].id;

      // The poll in between sees neither, and moves its cursor on.
      const between = await getChanges(contextOf(restaurant), first);
      expect(between.items.map((it) => it.id)).not.toContain(late);
      expect(between.items.find((it) => it.id === item.id)?.status ?? "placed").toBe("placed");

      await slow.query("commit");

      // The poll after the commit, from the cursor the one in between gave, has both.
      const after = await getChanges(contextOf(restaurant), between.cursor);
      expect(after.items.map((it) => it.id)).toContain(late);
      expect(after.items.find((it) => it.id === item.id)?.status).toBe("cooking");
    } finally {
      slow.release();
    }
  });

  it("stamps a change itself: a row can't be written with a stamp of its own choosing", async () => {
    const restaurant = await orderingRestaurant(owner.db);
    const { cursor } = await getBoard(contextOf(restaurant));
    const forged = await ordered(restaurant, { changeXid: 1 });

    const ids = (await getChanges(contextOf(restaurant), cursor)).items.map((item) => item.id);
    expect(ids).toContain(forged.id);
  });
});

describe("moving an item", () => {
  it("goes one step at a time, stamps the change, and bumps the session's activity in the same transaction", async () => {
    const restaurant = await orderingRestaurant(owner.db);
    const item = await ordered(restaurant);
    const before = new Date(Date.now() - 3_600_000);
    await owner.db
      .update(tableSessions)
      .set({ lastActivityAt: before })
      .where(eq(tableSessions.id, item.sessionId));
    await owner.db
      .update(orderItems)
      .set({ statusChangedAt: before })
      .where(eq(orderItems.id, item.id));

    const outcome = await moveItem(contextOf(restaurant), item.id, "placed", "cooking");

    expect(outcome).toMatchObject({ outcome: "done", item: { id: item.id, status: "cooking" } });
    const [line] = await owner.db.select().from(orderItems).where(eq(orderItems.id, item.id));
    const [session] = await owner.db.select().from(tableSessions).where(eq(tableSessions.id, item.sessionId));
    expect(line.status).toBe("cooking");
    expect(line.statusChangedAt.getTime()).toBeGreaterThan(before.getTime());
    expect(session.lastActivityAt.getTime()).toBeGreaterThan(before.getTime());
  });

  it("goes through cooking and done to delivered, and back one step from cooking or done", async () => {
    const restaurant = await orderingRestaurant(owner.db);
    const item = await ordered(restaurant);
    const ctx = contextOf(restaurant);

    expect((await moveItem(ctx, item.id, "placed", "cooking")).outcome).toBe("done");
    expect((await moveItem(ctx, item.id, "cooking", "placed")).outcome).toBe("done");
    expect((await moveItem(ctx, item.id, "placed", "cooking")).outcome).toBe("done");
    expect((await moveItem(ctx, item.id, "cooking", "done")).outcome).toBe("done");
    expect((await moveItem(ctx, item.id, "done", "cooking")).outcome).toBe("done");
    expect((await moveItem(ctx, item.id, "cooking", "done")).outcome).toBe("done");
    expect((await moveItem(ctx, item.id, "done", "delivered")).outcome).toBe("done");
    expect(await statusOfItem(item.id)).toBe("delivered");
  });

  it("refuses a move that skips a status, and changes nothing", async () => {
    const restaurant = await orderingRestaurant(owner.db);
    const item = await ordered(restaurant);

    expect(await moveItem(contextOf(restaurant), item.id, "placed", "done")).toEqual({
      outcome: "wrong_status",
      status: "placed",
    });
    expect(await statusOfItem(item.id)).toBe("placed");
  });

  it("refuses a move from a status the item has left (another tablet moved it first)", async () => {
    const restaurant = await orderingRestaurant(owner.db);
    const item = await ordered(restaurant);
    const ctx = contextOf(restaurant);
    await moveItem(ctx, item.id, "placed", "cooking");

    expect(await moveItem(ctx, item.id, "placed", "cooking")).toEqual({
      outcome: "wrong_status",
      status: "cooking",
    });
  });

  it("refuses a move back from delivered", async () => {
    const restaurant = await orderingRestaurant(owner.db);
    const item = await ordered(restaurant, { status: "delivered" });

    expect((await moveItem(contextOf(restaurant), item.id, "delivered", "done")).outcome).toBe(
      "wrong_status",
    );
    expect(await statusOfItem(item.id)).toBe("delivered");
  });

  it("two tablets moving the same item at once: one wins, the other is refused", async () => {
    const restaurant = await orderingRestaurant(owner.db);
    const item = await ordered(restaurant);
    const ctx = contextOf(restaurant);

    const outcomes = await Promise.all([
      moveItem(ctx, item.id, "placed", "cooking"),
      moveItem(ctx, item.id, "placed", "cooking"),
    ]);

    expect(outcomes.map((it) => it.outcome).sort()).toEqual(["done", "wrong_status"]);
  });

  it("can't reach another restaurant's item", async () => {
    const restaurant = await orderingRestaurant(owner.db);
    const other = await orderingRestaurant(owner.db);
    const theirs = await ordered(other);

    expect(await moveItem(contextOf(restaurant), theirs.id, "placed", "cooking")).toEqual({
      outcome: "not_found",
    });
    expect(await statusOfItem(theirs.id)).toBe("placed");
  });

  it("is audited with who moved it, from and to", async () => {
    const restaurant = await orderingRestaurant(owner.db);
    const item = await ordered(restaurant);

    await moveItem(contextOf(restaurant), item.id, "placed", "cooking");

    const entries = await owner.db.select().from(auditLog).where(eq(auditLog.entityId, item.id));
    expect(entries).toEqual([
      expect.objectContaining({
        restaurantId: restaurant.restaurantId,
        actorType: "staff",
        actorId: restaurant.staffId,
        action: "order_item.status",
        entityType: "order_item",
        details: { from: "placed", to: "cooking" },
      }),
    ]);
  });

  it("writes no audit entry and no activity for a refused move", async () => {
    const restaurant = await orderingRestaurant(owner.db);
    const item = await ordered(restaurant);
    const before = new Date(Date.now() - 3_600_000);
    await owner.db
      .update(tableSessions)
      .set({ lastActivityAt: before })
      .where(eq(tableSessions.id, item.sessionId));

    await moveItem(contextOf(restaurant), item.id, "cooking", "done");

    expect(await owner.db.select().from(auditLog).where(eq(auditLog.entityId, item.id))).toEqual([]);
    const [session] = await owner.db.select().from(tableSessions).where(eq(tableSessions.id, item.sessionId));
    expect(session.lastActivityAt).toEqual(before);
  });
});
