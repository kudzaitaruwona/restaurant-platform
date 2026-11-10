import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { diningTables, orderItems, orders, tableSessions } from "@/db/schema";
import type { TenantContext } from "@/lib/tenant";
import { openOwnerDatabase, testDatabaseSettings } from "../../../../test/integration/database";
import { orderingRestaurant } from "../../../../test/integration/ordering";
import { KitchenScreen } from "./kitchen-screen";

/** The kitchen board as markup, on a restaurant of its own. Who's asking is faked: access.int.test.ts has the real seam. */
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
  const [{ id }] = await owner.db.insert(orderItems).values({
    restaurantId: restaurant.restaurantId,
    orderId,
    menuItemId: restaurant.itemId,
    nameSnapshot: "Beef stew",
    quantity: 2,
    unitPriceUsd: "8",
    ...rest,
  }).returning({ id: orderItems.id });
  return { id, orderId };
}

/** The markup of one column, from its heading to the next one's. */
const column = (html: string, name: "Placed" | "Cooking" | "Done") => {
  const start = html.indexOf(`>${name}<`);
  const ends = [">Placed<", ">Cooking<", ">Done<"]
    .map((heading) => html.indexOf(heading, start + 1))
    .filter((at) => at > start);
  return html.slice(start, ends.length ? Math.min(...ends) : undefined);
};

describe("the kitchen screen", () => {
  it.each(["owner", "staff"] as const)(
    "shows each item with table, quantity × name, note and customer name, for %s",
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

  it("puts placed, cooking and done items in their columns, oldest first, and leaves delivered ones off", async () => {
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
    await ordered(restaurant, { customerName: "Cooker", status: "cooking" });
    await ordered(restaurant, { customerName: "Finished", status: "done" });
    await ordered(restaurant, { customerName: "Carried", status: "delivered" });

    const html = await render();

    const placed = column(html, "Placed");
    expect(placed.indexOf("First")).toBeLessThan(placed.indexOf("Second"));
    expect(placed).toContain("Patio 2");
    expect(placed).not.toContain("Cooker");
    expect(column(html, "Cooking")).toContain("Cooker");
    expect(column(html, "Done")).toContain("Finished");
    expect(html).not.toContain("Carried");
  });

  it("shows a long note whole, set apart from the rest of the card", async () => {
    const restaurant = await orderingRestaurant(owner.db);
    session.tenant = { restaurantId: restaurant.restaurantId, staffId: restaurant.staffId, role: "staff" };
    const note = `Allergic to peanuts. ${"Please keep it well away from anything with nuts. ".repeat(3)}`.slice(0, 200).trim();
    await ordered(restaurant, { note });

    const html = await render();

    expect(html).toContain(note);
    expect(html).toMatch(/data-note="true"/);
    expect(html).not.toMatch(/truncate|line-clamp|text-ellipsis/);
  });

  it("groups an order's items together and says how long ago it was ordered", async () => {
    const restaurant = await orderingRestaurant(owner.db);
    session.tenant = { restaurantId: restaurant.restaurantId, staffId: restaurant.staffId, role: "staff" };
    const { orderId } = await ordered(restaurant, { nameSnapshot: "Sadza" });
    await owner.db.insert(orderItems).values({
      restaurantId: restaurant.restaurantId,
      orderId,
      menuItemId: restaurant.itemId,
      nameSnapshot: "Greens",
      quantity: 1,
      unitPriceUsd: "2",
    });
    await owner.db
      .update(orders)
      .set({ placedAt: new Date(Date.now() - 20 * 60_000) })
      .where(eq(orders.id, orderId));

    const html = await render();

    const group = html.slice(html.indexOf(`data-order="${orderId}"`));
    expect(group).toContain("Sadza");
    expect(group).toContain("Greens");
    expect(html).toContain("20 min ago");
    expect(html).toMatch(/data-age="amber"/);
  });

  it("offers sound behind a tap, on load", async () => {
    const restaurant = await orderingRestaurant(owner.db);
    session.tenant = { restaurantId: restaurant.restaurantId, staffId: restaurant.staffId, role: "staff" };

    expect(await render()).toContain("Tap to enable sound");
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
