import "server-only";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { orderItems, orders, tableSessions } from "@/db/schema";
import type { ItemStatus } from "@/lib/kitchen-board";
import { type AuditEntry, recordAudits } from "@/lib/tenant/audit";
import { type TenantContext, type TenantTransaction, withTenant } from "@/lib/tenant/scope";

/**
 * Staff's override for D-01 (S-36, #73): void one item, or reject an order,
 * each with a reason. Owner and staff alike (S-26). Postgres holds the record
 * (order_items_void_recorded: a voided line has a non-blank reason and who
 * voided it) and its finality (order_items_void_final: a voided line stays
 * voided with its first reason, and a delivered one can't be voided).
 */

type Actor = Pick<TenantContext, "restaurantId" | "staffId" | "platformAdminId">;

/** A line voided by voidLines: its id, its order and the status it left. */
export type VoidedLine = { id: string; orderId: string; from: ItemStatus };

/**
 * Voids the lines of the restaurant that `scope` picks and are still in play
 * (placed, cooking or done), with one reason, inside the caller's transaction,
 * and audits each as `order_item.void` with its order, the status it left and
 * the reason. Delivered and already voided lines are left as they are. This is
 * the one void: a reject calls it for an order, and force-close (6.7) is meant
 * to call it for a session's outstanding lines before closing, in the same
 * transaction.
 *
 * `scope` is a condition on order_items (e.g. `eq(orderItems.orderId, id)`).
 * The lines are locked first, in id order, and `in_play` is checked again on
 * the locked row, so a line delivered or voided by someone else meanwhile is
 * left out rather than voided twice. The caller takes the session's row before
 * this, as a kitchen move does, so the two lock in the same order. The
 * platform admin who entered a restaurant voids as its shadow staff row
 * (`voided_by` → staff) and is audited as the admin (S-29).
 */
export async function voidLines(
  tx: TenantTransaction,
  actor: Actor,
  scope: SQL,
  reason: string,
): Promise<VoidedLine[]> {
  const { rows } = await tx.execute<{ id: string; order_id: string; from: ItemStatus }>(sql`
    with locked as (
      select ${orderItems.id} as id, ${orderItems.status} as status
      from ${orderItems}
      where ${orderItems.restaurantId} = ${actor.restaurantId} and ${orderItems.inPlay} and ${scope}
      order by ${orderItems.id}
      for update
    )
    update ${orderItems}
    set status = 'voided', void_reason = ${reason}, voided_by = ${actor.staffId},
        status_changed_at = now()
    from locked
    where ${orderItems.restaurantId} = ${actor.restaurantId} and ${orderItems.id} = locked.id
    returning ${orderItems.id} as id, ${orderItems.orderId} as order_id, locked.status as "from"
  `);
  const voided = rows
    .map((row) => ({ id: row.id, orderId: row.order_id, from: row.from }))
    .sort((a, b) => a.id.localeCompare(b.id));
  await recordAudits(
    tx,
    actor,
    voided.map(
      (line): AuditEntry => ({
        action: "order_item.void",
        entityType: "order_item",
        entityId: line.id,
        details: { orderId: line.orderId, from: line.from, reason },
      }),
    ),
  );
  return voided;
}

/** An item or order action counts as the session's activity (spec 06), while it is open. */
async function touchSession(tx: TenantTransaction, actor: Actor, sessionId: string) {
  await tx
    .update(tableSessions)
    .set({ lastActivityAt: sql`now()` })
    .where(
      and(
        eq(tableSessions.restaurantId, actor.restaurantId),
        eq(tableSessions.id, sessionId),
        eq(tableSessions.status, "open"),
      ),
    );
}

export type VoidOutcome =
  | { outcome: "done" }
  | { outcome: "not_found" }
  /** Delivered (it was eaten) or already voided (it keeps its first reason). */
  | { outcome: "wrong_status"; status: ItemStatus };

export type RejectOutcome =
  | { outcome: "done"; voided: string[] }
  | { outcome: "not_found" }
  /** Every item of the order is delivered or voided already. */
  | { outcome: "nothing_to_void" };

class Refused<T> extends Error {
  constructor(readonly outcome: T) {
    super("refused");
  }
}

/** Runs a void in one transaction; a refusal rolls back its activity bump. */
async function attempt<T>(actor: Actor, run: (tx: TenantTransaction) => Promise<T>): Promise<T> {
  try {
    return await withTenant(actor, run);
  } catch (error) {
    if (error instanceof Refused) return error.outcome as T;
    // A Drizzle error's message quotes the statement's parameters: the reason.
    const cause = (error as { cause?: { code?: string } } | null)?.cause;
    throw new Error(`voiding failed: ${cause?.code ?? "unknown"}`);
  }
}

/**
 * Voids one item (#73): placed, cooking or done, with a reason. A delivered or
 * voided item is refused, saying which; another restaurant's or an unknown one
 * is not found. The item, its audit entry and the session's activity commit
 * together or not at all.
 */
export function voidItem(actor: Actor, itemId: string, reason: string): Promise<VoidOutcome> {
  return attempt(actor, async (tx) => {
    const where = and(eq(orderItems.restaurantId, actor.restaurantId), eq(orderItems.id, itemId));
    const [line] = await tx
      .select({ sessionId: orders.sessionId })
      .from(orderItems)
      .innerJoin(
        orders,
        and(eq(orders.restaurantId, orderItems.restaurantId), eq(orders.id, orderItems.orderId)),
      )
      .where(where);
    if (!line) throw new Refused<VoidOutcome>({ outcome: "not_found" });

    await touchSession(tx, actor, line.sessionId);
    const voided = await voidLines(tx, actor, eq(orderItems.id, itemId), reason);
    if (voided.length === 0) {
      const [current] = await tx.select({ status: orderItems.status }).from(orderItems).where(where);
      throw new Refused<VoidOutcome>({ outcome: "wrong_status", status: current.status });
    }
    return { outcome: "done" } as const;
  });
}

/**
 * Rejects an order (S-36): voids every item of it not yet delivered, with one
 * reason. Delivered items stay delivered (proposed: they were carried to a real
 * table), and items already voided keep their first reason. Audited as
 * `order.reject` with the reason and the items it voided, besides each item's
 * `order_item.void`, all in one transaction with the session's activity. An
 * order with nothing left to void is refused and changes nothing.
 */
export function rejectOrder(actor: Actor, orderId: string, reason: string): Promise<RejectOutcome> {
  return attempt(actor, async (tx) => {
    const [order] = await tx
      .select({ sessionId: orders.sessionId })
      .from(orders)
      .where(and(eq(orders.restaurantId, actor.restaurantId), eq(orders.id, orderId)));
    if (!order) throw new Refused<RejectOutcome>({ outcome: "not_found" });

    await touchSession(tx, actor, order.sessionId);
    const voided = (await voidLines(tx, actor, eq(orderItems.orderId, orderId), reason)).map(
      (line) => line.id,
    );
    if (voided.length === 0) throw new Refused<RejectOutcome>({ outcome: "nothing_to_void" });
    await recordAudits(tx, actor, [
      { action: "order.reject", entityType: "order", entityId: orderId, details: { reason, voided } },
    ]);
    return { outcome: "done", voided } as const;
  });
}
