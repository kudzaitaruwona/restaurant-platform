import { renderToStaticMarkup } from "react-dom/server";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { diningTables, orderItems, orders, restaurants, tableSessions } from "@/db/schema";
import type { TenantContext } from "@/lib/tenant";
import { openOwnerDatabase, testDatabaseSettings } from "../../../../test/integration/database";
import { orderingRestaurant } from "../../../../test/integration/ordering";
import { FloorScreen } from "./floor-screen";
import { TableDetailScreen } from "./table-detail-screen";

/** The floor as markup, on a restaurant of its own. Who's asking is faked: access.int.test.ts has the real seam. */
const session = vi.hoisted(() => ({ tenant: undefined as unknown }));
vi.mock("@/lib/tenant", async (original) => ({
  ...(await original<typeof import("@/lib/tenant")>()),
  getTenantContext: async () => session.tenant as TenantContext,
}));

vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh() {} }),
}));

const owner = openOwnerDatabase();
beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});
afterAll(async () => {
  await owner.pool.end();
  vi.unstubAllEnvs();
});

type Restaurant = Awaited<ReturnType<typeof orderingRestaurant>>;
const as = (r: Restaurant, role: "owner" | "staff" = "staff") => {
  session.tenant = { restaurantId: r.restaurantId, staffId: r.staffId, role };
};

async function openTable(
  r: Restaurant,
  lines: (Partial<typeof orderItems.$inferInsert>)[],
  { openedAt = new Date(), customerName = "Tariro" } = {},
) {
  const [{ id: sessionId }] = await owner.db
    .insert(tableSessions)
    .values({ restaurantId: r.restaurantId, tableId: r.tableId, openedAt })
    .returning({ id: tableSessions.id });
  const [{ id: orderId }] = await owner.db
    .insert(orders)
    .values({ restaurantId: r.restaurantId, sessionId, customerName })
    .returning({ id: orders.id });
  for (const line of lines) {
    await owner.db.insert(orderItems).values({
      restaurantId: r.restaurantId,
      orderId,
      menuItemId: r.itemId,
      nameSnapshot: "Beef stew",
      quantity: 2,
      unitPriceUsd: "8",
      ...line,
    });
  }
}

describe("the floor screen", () => {
  it.each(["owner", "staff"] as const)("shows a free table with a link to its detail, for %s", async (role) => {
    const r = await orderingRestaurant(owner.db);
    as(r, role);

    const html = renderToStaticMarkup(await FloorScreen());

    expect(html).toContain("Table 7");
    expect(html).toContain("Free");
    expect(html).toContain(`href="/dashboard/floor/${r.tableId}"`);
  });

  it("shows an open table with its time open on the restaurant's clock and its item counts", async () => {
    const r = await orderingRestaurant(owner.db);
    as(r);
    await owner.db.update(restaurants).set({ timezone: "Pacific/Auckland" }).where(eq(restaurants.id, r.restaurantId));
    // 10:00 UTC is 23:00 in Auckland in January (UTC+13), and 35 minutes before "now".
    await openTable(r, [{ status: "placed" }, { status: "cooking" }, { status: "done" }, { status: "done" }], {
      openedAt: new Date("2031-01-01T10:00:00Z"),
    });

    const html = renderToStaticMarkup(await FloorScreen({ now: new Date("2031-01-01T10:35:00Z") }));

    expect(html).toContain("Open");
    expect(html).toContain("since 23:00");
    expect(html).toContain("35 min");
    expect(html).toMatch(/Placed[^0-9]*1/);
    expect(html).toMatch(/Cooking[^0-9]*1/);
    expect(html).toMatch(/Done[^0-9]*2/);
    expect(html).toMatch(/Delivered[^0-9]*0/);
  });

  it("says so when the restaurant has no tables", async () => {
    const r = await orderingRestaurant(owner.db);
    await owner.db.update(diningTables).set({ archivedAt: new Date() }).where(eq(diningTables.id, r.tableId));
    as(r, "owner");

    expect(renderToStaticMarkup(await FloorScreen())).toContain("No tables yet");
  });

  it("shows only its own restaurant's tables", async () => {
    const mine = await orderingRestaurant(owner.db);
    const theirs = await orderingRestaurant(owner.db, { name: "Theirs" });
    await owner.db.update(diningTables).set({ label: "Secret table" }).where(eq(diningTables.id, theirs.tableId));
    as(mine);

    expect(renderToStaticMarkup(await FloorScreen())).not.toContain("Secret table");
  });
});

describe("a table calling a waiter", () => {
  const calling = async (r: Restaurant) => {
    await openTable(r, [{ status: "placed" }]);
    await owner.db
      .update(tableSessions)
      .set({ waiterRequestedAt: new Date("2031-01-01T10:05:00Z") })
      .where(eq(tableSessions.tableId, r.tableId));
  };

  it("is marked on the grid with its time on the restaurant's clock, and can be dismissed from there", async () => {
    const r = await orderingRestaurant(owner.db);
    as(r);
    await owner.db.update(restaurants).set({ timezone: "Pacific/Auckland" }).where(eq(restaurants.id, r.restaurantId));
    await calling(r);

    const html = renderToStaticMarkup(await FloorScreen());

    expect(html).toContain("Calling a waiter since 23:05");
    expect(html).toContain(`action="/api/floor/${r.tableId}/dismiss-waiter"`);
  });

  it("is marked on the table's detail too, with the same dismiss", async () => {
    const r = await orderingRestaurant(owner.db);
    as(r);
    await calling(r);

    const html = renderToStaticMarkup(await TableDetailScreen({ tableId: r.tableId }));

    expect(html).toContain("Calling a waiter since");
    expect(html).toContain(`action="/api/floor/${r.tableId}/dismiss-waiter"`);
  });

  it("shows nothing, and no dismiss, on a table that isn't calling", async () => {
    const r = await orderingRestaurant(owner.db);
    as(r);
    await openTable(r, [{ status: "placed" }]);

    const grid = renderToStaticMarkup(await FloorScreen());
    const detail = renderToStaticMarkup(await TableDetailScreen({ tableId: r.tableId }));

    for (const html of [grid, detail]) {
      expect(html).not.toContain("Calling a waiter");
      expect(html).not.toContain("dismiss-waiter");
    }
  });
});

describe("the table detail screen", () => {
  it("lists orders and items with customer name, note and status, escaping what a customer typed", async () => {
    const r = await orderingRestaurant(owner.db);
    as(r);
    await openTable(r, [{ note: "No <b>onions</b>", status: "cooking" }], { customerName: "<i>Tariro</i>" });

    const html = renderToStaticMarkup(await TableDetailScreen({ tableId: r.tableId }));

    expect(html).toContain("Table 7");
    expect(html).toContain("&lt;i&gt;Tariro&lt;/i&gt;");
    expect(html).toContain("2 × Beef stew");
    expect(html).toContain("No &lt;b&gt;onions&lt;/b&gt;");
    expect(html).toContain("Cooking");
  });

  it("offers Mark delivered on done items only, posting to the deliver endpoint", async () => {
    const r = await orderingRestaurant(owner.db);
    as(r);
    await openTable(r, [{ status: "placed" }, { status: "done" }, { status: "delivered" }]);
    const [done] = await owner.db.select().from(orderItems)
      .where(and(eq(orderItems.status, "done"), eq(orderItems.restaurantId, r.restaurantId)));

    const html = renderToStaticMarkup(await TableDetailScreen({ tableId: r.tableId }));

    expect(html.match(/Mark delivered/g)).toHaveLength(1);
    expect(html).toContain(`action="/api/order-items/${done.id}/deliver"`);
  });

  it("offers Void, with a required reason, on items not yet delivered or voided (#73)", async () => {
    const r = await orderingRestaurant(owner.db);
    as(r);
    await openTable(r, [
      { status: "placed" },
      { status: "done" },
      { status: "delivered" },
      { status: "voided", voidReason: "Mistake", voidedBy: r.staffId },
    ]);
    const lines = await owner.db.select().from(orderItems).where(eq(orderItems.restaurantId, r.restaurantId));
    const id = (status: string) => lines.find((line) => line.status === status)!.id;

    const html = renderToStaticMarkup(await TableDetailScreen({ tableId: r.tableId }));

    expect(html).toContain(`action="/api/order-items/${id("placed")}/void"`);
    expect(html).toContain(`action="/api/order-items/${id("done")}/void"`);
    expect(html).not.toContain(`/api/order-items/${id("delivered")}/void`);
    expect(html).not.toContain(`/api/order-items/${id("voided")}/void`);
    expect(html.match(/<input[^>]*name="reason"[^>]*>/g)?.every((input) => /required/.test(input) && /maxLength="200"/i.test(input))).toBe(true);
    expect(html).toContain("Voided");
  });

  it("offers Reject order on an order with an item still to void, and not on one that's all delivered or voided (#73)", async () => {
    const r = await orderingRestaurant(owner.db);
    as(r);
    await openTable(r, [{ status: "delivered" }, { status: "cooking" }]);
    const [live] = await owner.db.select().from(orders).where(eq(orders.restaurantId, r.restaurantId));
    const [{ id: sessionId }] = await owner.db.select().from(tableSessions)
      .where(eq(tableSessions.restaurantId, r.restaurantId));
    const [{ id: finished }] = await owner.db
      .insert(orders)
      .values({ restaurantId: r.restaurantId, sessionId, customerName: "Farai" })
      .returning({ id: orders.id });
    await owner.db.insert(orderItems).values({
      restaurantId: r.restaurantId,
      orderId: finished,
      menuItemId: r.itemId,
      nameSnapshot: "Rice",
      quantity: 1,
      status: "delivered",
    });

    const html = renderToStaticMarkup(await TableDetailScreen({ tableId: r.tableId }));

    expect(html).toContain(`action="/api/orders/${live.id}/reject"`);
    expect(html).not.toContain(`/api/orders/${finished}/reject`);
  });

  it("offers Clear table and Force-close, with a required reason, each naming the session it shows (#74)", async () => {
    const r = await orderingRestaurant(owner.db);
    as(r);
    await openTable(r, [{ status: "cooking" }]);
    const [{ id: sessionId }] = await owner.db.select().from(tableSessions)
      .where(eq(tableSessions.restaurantId, r.restaurantId));

    const html = renderToStaticMarkup(await TableDetailScreen({ tableId: r.tableId }));

    const formOf = (action: string) =>
      html.match(new RegExp(`<form[^>]*action="${action}"[^>]*>.*?</form>`))?.[0] ?? "";
    const clear = formOf(`/api/floor/${r.tableId}/clear`);
    const force = formOf(`/api/floor/${r.tableId}/force-close`);
    expect(clear).toContain("Clear table");
    expect(clear).toContain(`name="session" value="${sessionId}"`);
    expect(force).toContain("Force-close");
    expect(force).toContain(`name="session" value="${sessionId}"`);
    expect(force).toMatch(/<input[^>]*required[^>]*name="reason"/);
  });

  it("says so for a free table, with nothing to clear or force-close", async () => {
    const r = await orderingRestaurant(owner.db);
    as(r);

    const html = renderToStaticMarkup(await TableDetailScreen({ tableId: r.tableId }));
    expect(html).toContain("No open session");
    expect(html).not.toContain("/clear");
    expect(html).not.toContain("/force-close");
  });

  it("is a 404 for another restaurant's table", async () => {
    const mine = await orderingRestaurant(owner.db);
    const theirs = await orderingRestaurant(owner.db);
    as(mine);

    await expect(TableDetailScreen({ tableId: theirs.tableId })).rejects.toMatchObject({
      digest: expect.stringContaining("404"),
    });
  });
});
