import { eq } from "drizzle-orm";
import type { Database } from "../../src/db/client";
import {
  categories,
  diningTables,
  exchangeRates,
  menuItems,
  orderItems,
  orders,
  restaurants,
  staff,
  tableSessions,
} from "../../src/db/schema";

const token = () => crypto.randomUUID().replaceAll("-", "").slice(0, 22);

/**
 * A restaurant a customer can order from, of its own: one table, one category,
 * one $8 item, and a rate of 26.2 unless a test says otherwise. Written as the
 * role that owns the tables. The rows stay behind, like every fixture restaurant.
 */
export async function orderingRestaurant(
  owner: Database,
  { rate = "26.2" as string | null, name = "Ordering restaurant" } = {},
) {
  const restaurantId = crypto.randomUUID();
  await owner.insert(restaurants).values({
    id: restaurantId,
    name,
    slug: `ordering-${restaurantId}`,
    menuToken: `ordering-${restaurantId}`,
    currencyMode: "both",
  });
  const [{ id: staffId }] = await owner
    .insert(staff)
    .values({ restaurantId, email: `${restaurantId}@example.test`, displayName: "Owner", role: "owner" })
    .returning({ id: staff.id });
  if (rate !== null) {
    await owner.insert(exchangeRates).values({ restaurantId, setBy: staffId, usdToZig: rate });
  }
  const [{ id: categoryId }] = await owner
    .insert(categories)
    .values({ restaurantId, name: "Mains" })
    .returning({ id: categories.id });
  const [{ id: itemId }] = await owner
    .insert(menuItems)
    .values({ restaurantId, categoryId, name: "Beef stew", priceUsd: "8" })
    .returning({ id: menuItems.id });
  const qrToken = token();
  const [{ id: tableId }] = await owner
    .insert(diningTables)
    .values({ restaurantId, label: "Table 7", capacity: 4, qrToken })
    .returning({ id: diningTables.id });
  return { restaurantId, staffId, categoryId, itemId, qrToken, tableId };
}

/** Every session of a table, oldest first. */
export const sessionsOf = (owner: Database, tableId: string) =>
  owner
    .select()
    .from(tableSessions)
    .where(eq(tableSessions.tableId, tableId))
    .orderBy(tableSessions.openedAt);

/** Every line ordered at a restaurant, with its order. */
export const linesOf = (owner: Database, restaurantId: string) =>
  owner
    .select({ line: orderItems, order: orders })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(eq(orderItems.restaurantId, restaurantId));
