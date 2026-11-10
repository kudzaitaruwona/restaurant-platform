import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { diningTables, orderItems, orders, tableSessions } from "@/db/schema";
import { type TenantContext, withTenant } from "@/lib/tenant/scope";

/**
 * What the kitchen has still to start (spec 07), for owner and staff alike
 * (S-26): every placed line, oldest first, with its table and who ordered it.
 * The board's columns, actions and polling come later (#71); this is the list
 * they grow from.
 */
export function getPlacedItems(ctx: Pick<TenantContext, "restaurantId">) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: orderItems.id,
        table: diningTables.label,
        quantity: orderItems.quantity,
        name: orderItems.nameSnapshot,
        note: orderItems.note,
        customerName: orders.customerName,
      })
      .from(orderItems)
      .innerJoin(
        orders,
        and(eq(orders.restaurantId, orderItems.restaurantId), eq(orders.id, orderItems.orderId)),
      )
      .innerJoin(
        tableSessions,
        and(
          eq(tableSessions.restaurantId, orders.restaurantId),
          eq(tableSessions.id, orders.sessionId),
        ),
      )
      .innerJoin(
        diningTables,
        and(
          eq(diningTables.restaurantId, tableSessions.restaurantId),
          eq(diningTables.id, tableSessions.tableId),
        ),
      )
      .where(and(eq(orderItems.restaurantId, ctx.restaurantId), eq(orderItems.status, "placed")))
      .orderBy(asc(orders.placedAt), asc(orderItems.id)),
  );
}
