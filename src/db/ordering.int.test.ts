import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { asTenant, bookableRestaurant } from "../../test/integration/bookings";
import { openOwnerDatabase, openTestDatabase } from "../../test/integration/database";
import { categories, menuItems, orderItems, orders, tableSessions } from "./schema";

/**
 * Ordering's guarantees in Postgres (spec 00 › 6, spec 06): written straight at
 * the database, as app_tenant where the app would be, with nothing of the app's
 * own checks in the way.
 */
const app = openTestDatabase();
const owner = openOwnerDatabase();
afterAll(() => Promise.all([app.pool.end(), owner.pool.end()]));

const TABLE_LOCK = { cause: { code: "23505", constraint: "table_sessions_one_open_per_table" } };
const check = (constraint: string) => ({ cause: { code: "23514", constraint } });

/** A restaurant with one table and one menu item, written as the owner role. */
async function restaurantWithItem() {
  const { restaurantId, tableIds: [tableId] } = await bookableRestaurant(owner.db);
  const [{ id: categoryId }] = await owner.db
    .insert(categories)
    .values({ restaurantId, name: "Mains" })
    .returning({ id: categories.id });
  const [{ id: menuItemId }] = await owner.db
    .insert(menuItems)
    .values({ restaurantId, categoryId, name: "Stew", priceUsd: "8" })
    .returning({ id: menuItems.id });
  return { restaurantId, tableId, menuItemId };
}

const openSession = (restaurantId: string, tableId: string) =>
  asTenant(app.db, restaurantId, async (tx) => {
    const [{ id }] = await tx
      .insert(tableSessions)
      .values({ restaurantId, tableId })
      .returning({ id: tableSessions.id });
    return id;
  });

const closeSession = (sessionId: string) =>
  owner.db
    .update(tableSessions)
    .set({ status: "closed", closedAt: new Date(), closeReason: "staff_clear" })
    .where(eq(tableSessions.id, sessionId));

const anOrder = (restaurantId: string, sessionId: string) => ({
  restaurantId,
  sessionId,
  customerName: "Tariro",
  rateUsed: "26.2",
});

const aLine = (restaurantId: string, orderId: string, menuItemId: string) => ({
  restaurantId,
  orderId,
  menuItemId,
  nameSnapshot: "Stew",
  quantity: 2,
  unitPriceUsd: "8",
  unitPriceZig: "210",
  zigSource: "calculated" as const,
});

const placeOrder = (restaurantId: string, sessionId: string) =>
  asTenant(app.db, restaurantId, async (tx) => {
    const [{ id }] = await tx
      .insert(orders)
      .values(anOrder(restaurantId, sessionId))
      .returning({ id: orders.id });
    return id;
  });

describe("the table lock", () => {
  it("refuses a second open session on a table", async () => {
    const { restaurantId, tableId } = await restaurantWithItem();
    await openSession(restaurantId, tableId);

    await expect(openSession(restaurantId, tableId)).rejects.toMatchObject(TABLE_LOCK);
  });

  it("allows a new session once the last one has closed", async () => {
    const { restaurantId, tableId } = await restaurantWithItem();
    await closeSession(await openSession(restaurantId, tableId));

    await expect(openSession(restaurantId, tableId)).resolves.toBeTypeOf("string");
  });

  it("leaves approved_at empty: nothing writes it in v1 (S-36)", async () => {
    const { restaurantId, tableId } = await restaurantWithItem();
    const id = await openSession(restaurantId, tableId);

    const [row] = await owner.db.select().from(tableSessions).where(eq(tableSessions.id, id));
    expect(row).toMatchObject({ status: "open", approvedAt: null, closedAt: null });
  });
});

describe("orders only go into an open session", () => {
  it("takes an order into an open session", async () => {
    const { restaurantId, tableId } = await restaurantWithItem();
    const sessionId = await openSession(restaurantId, tableId);

    await expect(placeOrder(restaurantId, sessionId)).resolves.toBeTypeOf("string");
  });

  it("refuses an order into a closed session, and writes nothing", async () => {
    const { restaurantId, tableId } = await restaurantWithItem();
    const sessionId = await openSession(restaurantId, tableId);
    await closeSession(sessionId);

    await expect(placeOrder(restaurantId, sessionId)).rejects.toMatchObject(
      check("orders_session_open"),
    );
    expect(await owner.db.select().from(orders).where(eq(orders.sessionId, sessionId))).toEqual([]);
  });

  it("refuses a line on an order whose session has closed since", async () => {
    const { restaurantId, tableId, menuItemId } = await restaurantWithItem();
    const sessionId = await openSession(restaurantId, tableId);
    const orderId = await placeOrder(restaurantId, sessionId);
    await closeSession(sessionId);

    await expect(
      asTenant(app.db, restaurantId, (tx) =>
        tx.insert(orderItems).values(aLine(restaurantId, orderId, menuItemId)),
      ),
    ).rejects.toMatchObject(check("order_items_session_open"));
  });

  it("can't point an order at another restaurant's session", async () => {
    const mine = await restaurantWithItem();
    const theirs = await restaurantWithItem();
    const theirSession = await openSession(theirs.restaurantId, theirs.tableId);

    await expect(placeOrder(mine.restaurantId, theirSession)).rejects.toMatchObject({
      cause: { code: "23503" },
    });
  });
});

describe("frozen prices", () => {
  async function line() {
    const { restaurantId, tableId, menuItemId } = await restaurantWithItem();
    const sessionId = await openSession(restaurantId, tableId);
    const orderId = await placeOrder(restaurantId, sessionId);
    const [{ id }] = await asTenant(app.db, restaurantId, (tx) =>
      tx
        .insert(orderItems)
        .values(aLine(restaurantId, orderId, menuItemId))
        .returning({ id: orderItems.id }),
    );
    return { restaurantId, tableId, sessionId, orderId, lineId: id, menuItemId };
  }

  it.each([
    ["menu_item_id", sql`menu_item_id = gen_random_uuid()`],
    ["special_id", sql`special_id = gen_random_uuid()`],
    ["name_snapshot", sql`name_snapshot = 'Cheaper stew'`],
    ["quantity", sql`quantity = 1`],
    ["unit_price_usd", sql`unit_price_usd = 1`],
    ["unit_price_zig", sql`unit_price_zig = null`],
    ["zig_source", sql`zig_source = 'fixed'`],
  ])("refuses a change to a line's %s", async (_column, assignment) => {
    const { restaurantId, lineId } = await line();

    await expect(
      asTenant(app.db, restaurantId, (tx) =>
        tx.execute(sql`update order_items set ${assignment} where id = ${lineId}`),
      ),
    ).rejects.toMatchObject(check("order_items_frozen"));
  });

  it("still lets a line's status move on", async () => {
    const { restaurantId, lineId } = await line();

    await asTenant(app.db, restaurantId, (tx) =>
      tx.update(orderItems).set({ status: "cooking" }).where(eq(orderItems.id, lineId)),
    );

    const [row] = await owner.db.select().from(orderItems).where(eq(orderItems.id, lineId));
    expect(row.status).toBe("cooking");
  });

  it("refuses a change to an order's rate_used, even by the owner role", async () => {
    const { orderId } = await line();

    await expect(
      owner.db.update(orders).set({ rateUsed: "1" }).where(eq(orders.id, orderId)),
    ).rejects.toMatchObject(check("orders_frozen"));
  });

  // Proposed, S-40: money can't shift between bills.
  it("refuses moving a line onto another order, even one of the same session", async () => {
    const { restaurantId, lineId, sessionId } = await line();
    const otherOrderId = await placeOrder(restaurantId, sessionId);

    await expect(
      asTenant(app.db, restaurantId, (tx) =>
        tx.update(orderItems).set({ orderId: otherOrderId }).where(eq(orderItems.id, lineId)),
      ),
    ).rejects.toMatchObject(check("order_items_frozen"));
  });

  it("refuses moving an order onto another session, open or closed", async () => {
    const { restaurantId, tableId, orderId: earlierOrderId, sessionId: closedId } = await line();
    await closeSession(closedId);
    const openId = await openSession(restaurantId, tableId);
    const laterOrderId = await placeOrder(restaurantId, openId);
    const move = (orderId: string, sessionId: string) =>
      asTenant(app.db, restaurantId, (tx) =>
        tx.update(orders).set({ sessionId }).where(eq(orders.id, orderId)),
      );

    await expect(move(earlierOrderId, openId)).rejects.toMatchObject(check("orders_frozen"));
    await expect(move(laterOrderId, closedId)).rejects.toMatchObject(check("orders_frozen"));
  });

  it("can't be deleted by the app: nothing customer-facing is hard-deleted", async () => {
    const { restaurantId, lineId, orderId } = await line();

    await expect(
      asTenant(app.db, restaurantId, (tx) => tx.delete(orderItems).where(eq(orderItems.id, lineId))),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
    await expect(
      asTenant(app.db, restaurantId, (tx) => tx.delete(orders).where(eq(orders.id, orderId))),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
  });
});

describe("the kitchen's index", () => {
  // Lines are never deleted, so a filter on restaurant_id alone would read the
  // restaurant's whole history on every load (spec 07 polls every 5 seconds).
  // The partial index holds only the lines still in play.
  it.each([
    ["the list of placed lines", sql`status = 'placed'`],
    ["the board's three columns (#71)", sql`status in ('placed', 'cooking', 'done')`],
  ])("serves %s", async (_what, filter) => {
    const { restaurantId } = await restaurantWithItem();

    const plan = await asTenant(app.db, restaurantId, async (tx) => {
      // An empty table would be read whole whatever the indexes; this asks
      // which index the planner can use.
      await tx.execute(sql`set local enable_seqscan = off`);
      const { rows } = await tx.execute(
        sql`explain select id from order_items where restaurant_id = ${restaurantId} and ${filter}`,
      );
      return rows.map((row) => Object.values(row).join("")).join("\n");
    });

    expect(plan).toContain("order_items_in_play");
  });
});

describe("what an order holds", () => {
  it.each(["", "   ", "x".repeat(101)])("refuses a customer name of %j", async (customerName) => {
    const { restaurantId, tableId } = await restaurantWithItem();
    const sessionId = await openSession(restaurantId, tableId);

    await expect(
      asTenant(app.db, restaurantId, (tx) =>
        tx.insert(orders).values({ ...anOrder(restaurantId, sessionId), customerName }),
      ),
    ).rejects.toMatchObject(check("orders_customer_name"));
  });

  it.each([
    ["a quantity of 0", { quantity: 0 }, "order_items_quantity"],
    ["a quantity of 21", { quantity: 21 }, "order_items_quantity"],
    ["a note of 201 characters", { note: "x".repeat(201) }, "order_items_note"],
    ["a blank note", { note: "  " }, "order_items_note"],
    ["a negative price", { unitPriceUsd: "-1" }, "order_items_prices_not_negative"],
    ["an infinite price", { unitPriceZig: "Infinity" }, "order_items_prices_finite"],
    ["a ZiG price with no source", { zigSource: null }, "order_items_zig_source"],
  ])("refuses a line with %s", async (_what, change, constraint) => {
    const { restaurantId, tableId, menuItemId } = await restaurantWithItem();
    const sessionId = await openSession(restaurantId, tableId);
    const orderId = await placeOrder(restaurantId, sessionId);

    await expect(
      asTenant(app.db, restaurantId, (tx) =>
        tx.insert(orderItems).values({ ...aLine(restaurantId, orderId, menuItemId), ...change }),
      ),
    ).rejects.toMatchObject(check(constraint));
  });

  it("takes a line with no ZiG price while there is no rate, and no source with it", async () => {
    const { restaurantId, tableId, menuItemId } = await restaurantWithItem();
    const sessionId = await openSession(restaurantId, tableId);
    const orderId = await placeOrder(restaurantId, sessionId);

    await asTenant(app.db, restaurantId, (tx) =>
      tx
        .insert(orderItems)
        .values({ ...aLine(restaurantId, orderId, menuItemId), unitPriceZig: null, zigSource: null }),
    );
  });
});
