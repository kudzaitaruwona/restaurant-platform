import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  diningTables,
  exchangeRates,
  menuItems,
  orders,
  specials,
  tableSessions,
} from "@/db/schema";
import { mintQrToken } from "@/lib/qr-token";
import {
  openOwnerDatabase,
  testDatabaseSettings,
} from "../../../../../../test/integration/database";
import {
  linesOf,
  orderingRestaurant,
  sessionsOf,
} from "../../../../../../test/integration/ordering";
import { POST as joinSession } from "../session/route";
import { POST } from "./route";

/**
 * Placing an order from a table's page (spec 06), as its script posts it: the
 * item, a quantity, a note and the customer's name, plus the session the page
 * joined, and nothing that says what anything costs. Against a real Postgres as
 * app_tenant.
 */
const owner = openOwnerDatabase();

beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});
afterAll(async () => {
  await owner.pool.end();
  vi.unstubAllEnvs();
});

const join = async (qrToken: string) =>
  (
    await (
      await joinSession(new Request("http://localhost/x", { method: "POST" }), {
        params: Promise.resolve({ qrToken }),
      })
    ).json()
  ).session as string;

const post = (qrToken: string, fields: Record<string, string>) =>
  POST(
    new Request(`http://localhost/api/t/${qrToken}/orders`, {
      method: "POST",
      body: new URLSearchParams(fields),
    }),
    { params: Promise.resolve({ qrToken }) },
  );

/** A restaurant with a joined session, and a way to order from it. */
async function seated(options?: Parameters<typeof orderingRestaurant>[1]) {
  const restaurant = await orderingRestaurant(owner.db, options);
  const session = await join(restaurant.qrToken);
  const order = (fields: Record<string, string> = {}) =>
    post(restaurant.qrToken, {
      item: restaurant.itemId,
      quantity: "2",
      name: "Tariro",
      session,
      ...fields,
    });
  return { ...restaurant, session, order };
}

describe("POST /api/t/[qrToken]/orders", () => {
  it("places one item into the table's session, with its prices worked out on the server", async () => {
    const { order, restaurantId, itemId, session } = await seated();

    const response = await order({ note: "  no onions  ", name: "  Tariro  " });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ placed: { name: "Beef stew", quantity: 2 } });
    const [{ line, order: placed }] = await linesOf(owner.db, restaurantId);
    expect(placed).toMatchObject({ sessionId: session, customerName: "Tariro", rateUsed: "26.2" });
    expect(line).toMatchObject({
      menuItemId: itemId,
      specialId: null,
      nameSnapshot: "Beef stew",
      quantity: 2,
      unitPriceUsd: "8",
      unitPriceZig: "210",
      zigSource: "calculated",
      note: "no onions",
      status: "placed",
    });
  });

  it("bumps the session's last activity", async () => {
    const { order, session, tableId } = await seated();
    await owner.db
      .update(tableSessions)
      .set({ lastActivityAt: sql`now() - interval '30 minutes'` })
      .where(eq(tableSessions.id, session));

    expect((await order()).status).toBe(201);

    const [current] = await sessionsOf(owner.db, tableId);
    expect(Date.now() - current.lastActivityAt.getTime()).toBeLessThan(60_000);
  });

  it("stores no note for a blank one", async () => {
    const { order, restaurantId } = await seated();

    expect((await order({ note: "   " })).status).toBe(201);

    expect((await linesOf(owner.db, restaurantId))[0].line.note).toBeNull();
  });

  it("freezes the item's own fixed ZiG price as fixed", async () => {
    const { order, restaurantId, itemId } = await seated();
    await owner.db.update(menuItems).set({ priceZig: "199" }).where(eq(menuItems.id, itemId));

    await order();

    expect((await linesOf(owner.db, restaurantId))[0].line).toMatchObject({
      unitPriceUsd: "8",
      unitPriceZig: "199",
      zigSource: "fixed",
    });
  });

  it("freezes a live special's price, and records the special", async () => {
    const { order, restaurantId, itemId } = await seated();
    const [{ id: specialId }] = await owner.db
      .insert(specials)
      .values({ restaurantId, menuItemId: itemId, title: "Stew day", specialPriceUsd: "6" })
      .returning({ id: specials.id });

    await order();

    expect((await linesOf(owner.db, restaurantId))[0].line).toMatchObject({
      specialId,
      unitPriceUsd: "6",
      unitPriceZig: "160",
      zigSource: "calculated",
    });
  });

  it("ignores a special that is off, or outside its window", async () => {
    const { order, restaurantId, itemId } = await seated();
    await owner.db.insert(specials).values([
      { restaurantId, menuItemId: itemId, title: "Off", specialPriceUsd: "1", active: false },
      {
        restaurantId,
        menuItemId: itemId,
        title: "Over",
        specialPriceUsd: "2",
        startsAt: new Date("2020-01-01T00:00:00Z"),
        endsAt: new Date("2020-01-02T00:00:00Z"),
      },
    ]);

    await order();

    expect((await linesOf(owner.db, restaurantId))[0].line).toMatchObject({
      specialId: null,
      unitPriceUsd: "8",
    });
  });

  it("stores a currency it can't work out yet as null, as the menu shows it", async () => {
    const { order, restaurantId } = await seated({ rate: null });

    expect((await order()).status).toBe(201);

    const [{ line, order: placed }] = await linesOf(owner.db, restaurantId);
    expect(placed.rateUsed).toBeNull();
    expect(line).toMatchObject({ unitPriceUsd: "8", unitPriceZig: null, zigSource: null });
  });

  it("keeps the order's lines as they were when the price, the rate or the special changes", async () => {
    const { order, restaurantId, itemId, staffId } = await seated();
    const [{ id: specialId }] = await owner.db
      .insert(specials)
      .values({ restaurantId, menuItemId: itemId, title: "Stew day", specialPriceUsd: "6" })
      .returning({ id: specials.id });
    await order();
    const [before] = await linesOf(owner.db, restaurantId);

    await owner.db.update(menuItems).set({ priceUsd: "12" }).where(eq(menuItems.id, itemId));
    await owner.db.insert(exchangeRates).values({ restaurantId, setBy: staffId, usdToZig: "40" });
    await owner.db.update(specials).set({ active: false }).where(eq(specials.id, specialId));

    expect(await linesOf(owner.db, restaurantId)).toEqual([before]);
  });

  it("takes no price, rate, restaurant, table or session to write to from the request", async () => {
    const mine = await seated();
    const theirs = await seated();

    const response = await mine.order({
      price: "0",
      priceUsd: "0",
      unitPriceUsd: "0",
      unit_price_usd: "0",
      rate: "1",
      rateUsed: "1",
      restaurantId: theirs.restaurantId,
      restaurant_id: theirs.restaurantId,
      tableId: theirs.tableId,
      table_id: theirs.tableId,
      sessionId: theirs.session,
    });

    expect(response.status).toBe(201);
    const [{ line, order }] = await linesOf(owner.db, mine.restaurantId);
    expect(order).toMatchObject({ sessionId: mine.session, rateUsed: "26.2" });
    expect(line.unitPriceUsd).toBe("8");
    expect(await linesOf(owner.db, theirs.restaurantId)).toEqual([]);
  });

  it.each([
    ["archived", { archivedAt: new Date() }],
    ["sold out", { available: false }],
  ])("refuses an item that is %s with a 409, and writes nothing", async (_what, change) => {
    const { order, restaurantId, itemId } = await seated();
    await owner.db.update(menuItems).set(change).where(eq(menuItems.id, itemId));

    const response = await order();

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/isn't available/);
    expect(await linesOf(owner.db, restaurantId)).toEqual([]);
    expect(await owner.db.select().from(orders).where(eq(orders.restaurantId, restaurantId))).toEqual([]);
  });

  it("refuses a bundle outside its special's window, and takes it inside one", async () => {
    const { order, restaurantId, categoryId } = await seated();
    const [{ id: bundle }] = await owner.db
      .insert(menuItems)
      .values({ restaurantId, categoryId, name: "Lunch combo", priceUsd: "12", visibility: "special_only" })
      .returning({ id: menuItems.id });
    const [{ id: specialId }] = await owner.db
      .insert(specials)
      .values({
        restaurantId,
        menuItemId: bundle,
        title: "Lunch deal",
        startsAt: new Date(Date.now() + 3_600_000),
      })
      .returning({ id: specials.id });

    expect((await order({ item: bundle })).status).toBe(409);
    expect(await linesOf(owner.db, restaurantId)).toEqual([]);

    await owner.db.update(specials).set({ startsAt: null }).where(eq(specials.id, specialId));
    expect((await order({ item: bundle })).status).toBe(201);
    expect((await linesOf(owner.db, restaurantId))[0].line).toMatchObject({
      specialId,
      unitPriceUsd: "12",
    });
  });

  it("refuses another restaurant's item as unavailable: nothing crosses", async () => {
    const mine = await seated();
    const theirs = await orderingRestaurant(owner.db);

    expect((await mine.order({ item: theirs.itemId })).status).toBe(409);
    expect(await linesOf(owner.db, mine.restaurantId)).toEqual([]);
    expect(await linesOf(owner.db, theirs.restaurantId)).toEqual([]);
  });

  it.each([
    ["a blank name", { name: "   " }],
    ["a name of 101 characters", { name: "x".repeat(101) }],
    ["no name", { name: "" }],
    ["a quantity of 0", { quantity: "0" }],
    ["a quantity of 21", { quantity: "21" }],
    ["a quantity that isn't a whole number", { quantity: "1.5" }],
    ["a note of 201 characters", { note: "x".repeat(201) }],
    ["an item that isn't an id", { item: "not-a-uuid" }],
    ["a session that isn't an id", { session: "nope" }],
  ])("is a 400 for %s, and writes nothing", async (_what, fields) => {
    const { order, restaurantId } = await seated();

    const response = await order(fields);

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBeTypeOf("string");
    expect(await linesOf(owner.db, restaurantId)).toEqual([]);
  });

  it("refuses a stale tab with a 409 once its session is no longer the table's open one", async () => {
    const { order, restaurantId, session, qrToken } = await seated();
    await owner.db
      .update(tableSessions)
      .set({ status: "closed", closedAt: new Date(), closeReason: "staff_clear" })
      .where(eq(tableSessions.id, session));

    // No session open at all.
    const closed = await order();
    expect(closed.status).toBe(409);
    expect((await closed.json()).code).toBe("session_changed");

    // A new party has opened the table since.
    const fresh = await join(qrToken);
    const stale = await order();
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe("session_changed");
    expect(await linesOf(owner.db, restaurantId)).toEqual([]);

    // The page rejoins, and its order then goes into the new party's session.
    expect((await order({ session: fresh })).status).toBe(201);
    expect((await linesOf(owner.db, restaurantId))[0].order.sessionId).toBe(fresh);
  });

  it("can't order into another table's session by naming it", async () => {
    const mine = await seated();
    const theirs = await seated();

    const response = await mine.order({ session: theirs.session });

    expect(response.status).toBe(409);
    expect(await linesOf(owner.db, theirs.restaurantId)).toEqual([]);
    expect(await linesOf(owner.db, mine.restaurantId)).toEqual([]);
  });

  it("is a 404 for an unknown token, and writes nothing", async () => {
    const { restaurantId, session, itemId } = await seated();
    for (const token of ["no-such-token", mintQrToken(), "\0"]) {
      const response = await post(token, { item: itemId, quantity: "1", name: "T", session });
      expect(response.status).toBe(404);
    }
    expect(await linesOf(owner.db, restaurantId)).toEqual([]);
  });

  it.each([
    ["regenerated", () => ({ qrToken: mintQrToken() })],
    ["archived", () => ({ archivedAt: new Date() })],
  ])(
    "a tab that joined before its table's token was %s can't order into that session any more",
    async (_what, change) => {
      const { order, restaurantId, tableId } = await seated();
      await owner.db.update(diningTables).set(change()).where(eq(diningTables.id, tableId));

      const response = await order();

      expect(response.status).toBe(404);
      expect(await linesOf(owner.db, restaurantId)).toEqual([]);
    },
  );

  it("takes 10 orders from a session in 5 minutes, then answers 429 and writes nothing", async () => {
    const { order, restaurantId } = await seated();
    for (let n = 0; n < 10; n++) expect((await order()).status).toBe(201);

    const refused = await order();

    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(refused.headers.get("retry-after"))).toBeLessThanOrEqual(300);
    expect(await linesOf(owner.db, restaurantId)).toHaveLength(10);
  });

  it("counts only the last 5 minutes towards the limit", async () => {
    const { order, restaurantId, session } = await seated();
    for (let n = 0; n < 10; n++) await order();
    await owner.db.execute(
      sql`update orders set placed_at = now() - interval '6 minutes' where session_id = ${session}`,
    );

    expect((await order()).status).toBe(201);
    expect(await linesOf(owner.db, restaurantId)).toHaveLength(11);
  });

  it("holds the limit when the orders arrive at once", async () => {
    const { order, restaurantId } = await seated();

    const statuses = await Promise.all(Array.from({ length: 14 }, () => order().then((r) => r.status)));

    expect(statuses.filter((status) => status === 201)).toHaveLength(10);
    expect(statuses.filter((status) => status === 429)).toHaveLength(4);
    expect(await linesOf(owner.db, restaurantId)).toHaveLength(10);
  });

  it("refuses a body over the size limit with a 413", async () => {
    const { order, restaurantId } = await seated();

    expect((await order({ note: "x".repeat(10_000) })).status).toBe(413);
    expect(await linesOf(owner.db, restaurantId)).toEqual([]);
  });

  it("is never stored by a cache", async () => {
    const { order } = await seated();
    expect((await order()).headers.get("cache-control")).toBe("no-store");
  });
});
