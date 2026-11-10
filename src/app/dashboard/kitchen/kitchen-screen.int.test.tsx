import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { diningTables, orderItems, orders, tableSessions } from "@/db/schema";
import type { TenantContext } from "@/lib/tenant";
import { openOwnerDatabase, testDatabaseSettings } from "../../../../test/integration/database";
import { orderingRestaurant } from "../../../../test/integration/ordering";
import { KitchenScreen } from "./kitchen-screen";

/** The kitchen's list as markup, on a restaurant of its own. Who's asking is faked: access.int.test.ts has the real seam. */
const session = vi.hoisted(() => ({ tenant: undefined as unknown }));
vi.mock("@/lib/tenant", async (original) => ({
  ...(await original<typeof import("@/lib/tenant")>()),
  getTenantContext: async () => session.tenant as TenantContext,
}));

const owner = openOwnerDatabase();
beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});
afterAll(async () => {
  await owner.pool.end();
  vi.unstubAllEnvs();
});

const render = async () => renderToStaticMarkup(await KitchenScreen());

/** An order of one line on the restaurant's table, written as the owner role. */
async function ordered(
  restaurant: Awaited<ReturnType<typeof orderingRestaurant>>,
  line: Partial<typeof orderItems.$inferInsert> & { customerName?: string; tableId?: string } = {},
) {
  const { customerName = "Tariro", tableId = restaurant.tableId, ...rest } = line;
  const [open] = await owner.db
    .select({ id: tableSessions.id })
    .from(tableSessions)
    .where(eq(tableSessions.tableId, tableId));
  const sessionId =
    open?.id ??
    (
      await owner.db
        .insert(tableSessions)
        .values({ restaurantId: restaurant.restaurantId, tableId })
        .returning({ id: tableSessions.id })
    )[0].id;
  const [{ id: orderId }] = await owner.db
    .insert(orders)
    .values({ restaurantId: restaurant.restaurantId, sessionId, customerName })
    .returning({ id: orders.id });
  await owner.db.insert(orderItems).values({
    restaurantId: restaurant.restaurantId,
    orderId,
    menuItemId: restaurant.itemId,
    nameSnapshot: "Beef stew",
    quantity: 2,
    unitPriceUsd: "8",
    ...rest,
  });
}

describe("the kitchen screen", () => {
  it.each(["owner", "staff"] as const)(
    "lists placed items with table, quantity × name, note and customer name, for %s",
    async (role) => {
      const restaurant = await orderingRestaurant(owner.db);
      session.tenant = { restaurantId: restaurant.restaurantId, staffId: restaurant.staffId, role };
      await ordered(restaurant, { note: "No <b>onions</b>", customerName: "Tariro" });

      const html = await render();

      expect(html).toContain("Table 7");
      expect(html).toContain("2 × Beef stew");
      expect(html).toContain("No &lt;b&gt;onions&lt;/b&gt;");
      expect(html).toContain("Tariro");
    },
  );

  it("shows the name the line was ordered under, not the item's name now", async () => {
    const restaurant = await orderingRestaurant(owner.db);
    session.tenant = { restaurantId: restaurant.restaurantId, staffId: restaurant.staffId, role: "staff" };
    await ordered(restaurant, { nameSnapshot: "Old name" });

    expect(await render()).toContain("2 × Old name");
  });

  it("lists placed items only, oldest first", async () => {
    const restaurant = await orderingRestaurant(owner.db);
    session.tenant = { restaurantId: restaurant.restaurantId, staffId: restaurant.staffId, role: "staff" };
    const [{ id: secondTable }] = await owner.db
      .insert(diningTables)
      .values({
        restaurantId: restaurant.restaurantId,
        label: "Patio 2",
        capacity: 2,
        qrToken: crypto.randomUUID().replaceAll("-", "").slice(0, 22),
      })
      .returning({ id: diningTables.id });
    await ordered(restaurant, { customerName: "First" });
    await ordered(restaurant, { customerName: "Second", tableId: secondTable });
    await ordered(restaurant, { customerName: "Cooking", status: "cooking" });

    const html = await render();

    expect(html.indexOf("First")).toBeLessThan(html.indexOf("Second"));
    expect(html).toContain("Patio 2");
    expect(html).not.toContain("Cooking");
  });

  it("says so when nothing is waiting", async () => {
    const restaurant = await orderingRestaurant(owner.db);
    session.tenant = { restaurantId: restaurant.restaurantId, staffId: restaurant.staffId, role: "owner" };

    expect(await render()).toContain("No orders waiting");
  });

  it("shows only its own restaurant's orders", async () => {
    const mine = await orderingRestaurant(owner.db);
    const theirs = await orderingRestaurant(owner.db);
    await ordered(theirs, { customerName: "Someone else's" });
    session.tenant = { restaurantId: mine.restaurantId, staffId: mine.staffId, role: "owner" };

    const html = await render();

    expect(html).not.toContain("Someone else");
    expect(html).toContain("No orders waiting");
  });
});
