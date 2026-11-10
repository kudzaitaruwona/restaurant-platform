import "server-only";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { notFound } from "next/navigation";
import { z } from "zod";
import { diningTables, orderItems, orders, restaurants, tableSessions } from "@/db/schema";
import { moveItem } from "@/lib/kitchen";
import { recordAudit } from "@/lib/tenant/audit";
import { type TenantContext, type TenantTransaction, withTenant } from "@/lib/tenant/scope";

/**
 * Front-of-house's view of the floor (spec 06, Staff: floor view), for owner and
 * staff alike (S-26): every live table with the state of its open session, a
 * table's orders and items, and mark delivered. Voiding and rejecting are in
 * src/lib/voids.ts (#73); clearing, force-closing and reopening come later.
 */

type Tenant = Pick<TenantContext, "restaurantId">;
type Actor = Pick<TenantContext, "restaurantId" | "staffId" | "platformAdminId">;

type ItemStatus = (typeof orderItems.$inferSelect)["status"];

/** The statuses the grid counts. A voided line was never served or owed, so it isn't one of them. */
const counted = ["placed", "cooking", "done", "delivered"] as const;
export type ItemCounts = Record<(typeof counted)[number], number>;

const noCounts = (): ItemCounts => ({ placed: 0, cooking: 0, done: 0, delivered: 0 });

/**
 * The live tables in sort order, each with its open session, if any, found
 * from the table on table_sessions_one_open_per_table. Not a read of the
 * restaurant's sessions filtered on status: as app_tenant, under RLS, Postgres
 * can't use status's statistics (the enum's comparisons aren't leakproof), so
 * it would read every session the restaurant ever had to find the open ones.
 * Exported, with floorCounts, so a test can EXPLAIN exactly what the grid sends.
 */
export const floorTables = (tx: TenantTransaction, ctx: Tenant) =>
  tx
    .select({
      id: diningTables.id,
      label: diningTables.label,
      capacity: diningTables.capacity,
      sessionId: tableSessions.id,
      openedAt: tableSessions.openedAt,
      waiterRequestedAt: tableSessions.waiterRequestedAt,
    })
    .from(diningTables)
    .leftJoin(
      tableSessions,
      and(
        eq(tableSessions.restaurantId, diningTables.restaurantId),
        eq(tableSessions.tableId, diningTables.id),
        eq(tableSessions.status, "open"),
      ),
    )
    .where(and(eq(diningTables.restaurantId, ctx.restaurantId), isNull(diningTables.archivedAt)))
    .orderBy(asc(diningTables.sortOrder), asc(diningTables.label));

/**
 * The counted lines of the given sessions by session and status, read from
 * their orders (orders_restaurant_id_session_id_placed_at_index) and those
 * orders' lines, so none of the restaurant's history is read.
 */
export const floorCounts = (tx: TenantTransaction, ctx: Tenant, sessionIds: string[]) =>
  tx
    .select({
      sessionId: orders.sessionId,
      status: orderItems.status,
      lines: sql<number>`count(*)::int`,
    })
    .from(orders)
    .innerJoin(
      orderItems,
      and(eq(orderItems.restaurantId, orders.restaurantId), eq(orderItems.orderId, orders.id)),
    )
    .where(
      and(
        eq(orders.restaurantId, ctx.restaurantId),
        inArray(orders.sessionId, sessionIds),
        inArray(orderItems.status, [...counted]),
      ),
    )
    .groupBy(orders.sessionId, orderItems.status);

/** The live tables in sort order, each free or open, with its open session's item counts. */
export function getFloor(ctx: Tenant) {
  return withTenant(ctx, async (tx) => {
    const [{ timezone }] = await tx
      .select({ timezone: restaurants.timezone })
      .from(restaurants)
      .where(eq(restaurants.id, ctx.restaurantId));
    const tables = await floorTables(tx, ctx);
    const sessionIds = tables.flatMap((table) => (table.sessionId ? [table.sessionId] : []));
    // One grouped read of the open sessions' lines (spec 06: counts by status).
    const grouped = sessionIds.length === 0 ? [] : await floorCounts(tx, ctx, sessionIds);

    return {
      timezone,
      tables: tables.map(({ sessionId, openedAt, waiterRequestedAt, ...table }) => {
        const counts = noCounts();
        for (const row of grouped) {
          if (row.sessionId === sessionId) counts[row.status as keyof ItemCounts] = row.lines;
        }
        return {
          ...table,
          status: sessionId ? ("open" as const) : ("free" as const),
          openedAt: openedAt ?? null,
          /** Since when the open session has been calling a waiter (spec 06, proposed), if it is. */
          waiterRequestedAt: waiterRequestedAt ?? null,
          counts,
        };
      }),
    };
  });
}

/**
 * One live table with every order and line of its open session, oldest first, or
 * null when there is no such live table here. A free table has no session and no
 * orders: a closed session's belong to a bill nobody is serving any more.
 */
export function getTableDetail(ctx: Tenant, tableId: string) {
  return withTenant(ctx, async (tx) => {
    const [{ timezone }] = await tx
      .select({ timezone: restaurants.timezone })
      .from(restaurants)
      .where(eq(restaurants.id, ctx.restaurantId));
    const [table] = await tx
      .select({ id: diningTables.id, label: diningTables.label, capacity: diningTables.capacity })
      .from(diningTables)
      .where(
        and(
          eq(diningTables.restaurantId, ctx.restaurantId),
          eq(diningTables.id, tableId),
          isNull(diningTables.archivedAt),
        ),
      );
    if (!table) return null;

    const [session] = await tx
      .select({
        id: tableSessions.id,
        openedAt: tableSessions.openedAt,
        waiterRequestedAt: tableSessions.waiterRequestedAt,
      })
      .from(tableSessions)
      .where(
        and(
          eq(tableSessions.restaurantId, ctx.restaurantId),
          eq(tableSessions.tableId, table.id),
          eq(tableSessions.status, "open"),
        ),
      );
    if (!session) return { timezone, table, session: null, orders: [] };

    const rows = await tx
      .select({
        orderId: orders.id,
        customerName: orders.customerName,
        placedAt: orders.placedAt,
        itemId: orderItems.id,
        name: orderItems.nameSnapshot,
        quantity: orderItems.quantity,
        note: orderItems.note,
        status: orderItems.status,
      })
      .from(orders)
      .innerJoin(
        orderItems,
        and(eq(orderItems.restaurantId, orders.restaurantId), eq(orderItems.orderId, orders.id)),
      )
      .where(and(eq(orders.restaurantId, ctx.restaurantId), eq(orders.sessionId, session.id)))
      .orderBy(asc(orders.placedAt), asc(orders.id), asc(orderItems.id));

    const byOrder = new Map<
      string,
      { id: string; customerName: string; placedAt: Date; items: { id: string; name: string; quantity: number; note: string | null; status: ItemStatus }[] }
    >();
    for (const row of rows) {
      const order =
        byOrder.get(row.orderId) ??
        { id: row.orderId, customerName: row.customerName, placedAt: row.placedAt, items: [] };
      order.items.push({
        id: row.itemId,
        name: row.name,
        quantity: row.quantity,
        note: row.note,
        status: row.status,
      });
      byOrder.set(row.orderId, order);
    }
    return { timezone, table, session, orders: [...byOrder.values()] };
  });
}

export type DeliverOutcome =
  | { outcome: "done" }
  | { outcome: "not_found" }
  /** Someone else got there first, or the line was never done. */
  | { outcome: "wrong_status"; status: ItemStatus };

export type DismissOutcome =
  | { outcome: "done" }
  /** No call was pending, or someone else dismissed it first. */
  | { outcome: "nothing_pending" }
  | { outcome: "not_found" };

/**
 * Staff answer a table's "Call a waiter" (spec 06, proposed: the spec doesn't say
 * how a call ends). Clears the flag on the table's open session, and audits who
 * did it, only when it was pending, so two staff dismissing at once leave one
 * entry. Not activity: only the customer's call keeps a session alive.
 */
export function dismissWaiter(actor: Actor, tableId: string): Promise<DismissOutcome> {
  return withTenant(actor, async (tx) => {
    const [table] = await tx
      .select({ id: diningTables.id })
      .from(diningTables)
      .where(
        and(
          eq(diningTables.restaurantId, actor.restaurantId),
          eq(diningTables.id, tableId),
          isNull(diningTables.archivedAt),
        ),
      );
    if (!table) return { outcome: "not_found" };
    const [cleared] = await tx
      .update(tableSessions)
      .set({ waiterRequestedAt: null })
      .where(
        and(
          eq(tableSessions.restaurantId, actor.restaurantId),
          eq(tableSessions.tableId, table.id),
          eq(tableSessions.status, "open"),
          isNotNull(tableSessions.waiterRequestedAt),
        ),
      )
      .returning({ id: tableSessions.id });
    if (!cleared) return { outcome: "nothing_pending" };
    await recordAudit(tx, actor, {
      action: "table_session.waiter_dismiss",
      entityType: "table_session",
      entityId: cleared.id,
    });
    return { outcome: "done" };
  });
}

/** The id in an order item route. A malformed one is a 404, like an unknown one. */
export async function orderItemIdFrom(params: Promise<{ itemId: string }>) {
  const parsed = z.uuid().safeParse((await params).itemId);
  if (!parsed.success) notFound();
  return parsed.data;
}

/**
 * Front-of-house hands a finished line over (spec 07: Delivered is set by them).
 * This is the kitchen board's own `done → delivered` move (moveItem), so the two
 * ways to deliver are one behaviour: `WHERE status = 'done'` gives two taps at
 * once one winner, the open session's last activity moves in the same
 * transaction, and the change is audited as `order_item.status` for owner and
 * staff alike. Delivering the last line leaves the session open: only clearing
 * the table closes it (spec 06, Sessions).
 */
export async function markItemDelivered(actor: Actor, itemId: string): Promise<DeliverOutcome> {
  const moved = await moveItem(actor, itemId, "done", "delivered");
  return moved.outcome === "done" ? { outcome: "done" } : moved;
}
