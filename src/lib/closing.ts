import "server-only";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { diningTables, orderItems, orders, tableSessions } from "@/db/schema";
import type { ItemStatus } from "@/lib/kitchen-board";
import { recordAdminAction, recordAudit } from "@/lib/tenant/audit";
import { type TenantContext, type TenantTransaction, withTenant } from "@/lib/tenant/scope";
import { voidLines } from "@/lib/voids";

/**
 * Closing a table's session from the floor view (spec 06, Sessions; #74), for
 * owner and staff alike (S-26). **Clear table** closes a session whose items are
 * all delivered or voided; **force-close** voids the outstanding ones with one
 * reason, then closes, in one transaction. Postgres holds the rule: the closure
 * gate (table_sessions_closure_gate, migration 0045) refuses any close while an
 * item is in play, whoever asks. These checks only let the floor say which
 * items are in the way.
 *
 * A close names the session the page showed, as a precondition, not a key: the
 * session is found from the table, and if it isn't the one shown (it has closed,
 * or a new party has opened one since), nothing happens. An old page's tap can't
 * close the next party's session.
 */

type Tenant = Pick<TenantContext, "restaurantId">;
type Actor = Pick<TenantContext, "restaurantId" | "staffId" | "platformAdminId">;

/** An item that keeps a session open: placed, cooking or done. */
export type OutstandingItem = {
  id: string;
  name: string;
  quantity: number;
  status: ItemStatus;
  customerName: string;
};

export type ClearOutcome =
  | { outcome: "done" }
  | { outcome: "not_found" }
  /** The table's open session isn't the one the page showed: none now, or a new party's. */
  | { outcome: "session_changed" }
  /** Items not yet delivered or voided: deliver or void them, or force-close. */
  | { outcome: "blocked"; items: OutstandingItem[] };

export type ForceCloseOutcome =
  | { outcome: "done"; voided: string[] }
  | { outcome: "not_found" }
  | { outcome: "session_changed" };

/**
 * The table's open session, locked for the close, found on
 * table_sessions_one_open_per_table so none of the table's past sessions is
 * read. Locking it first is the order a kitchen move and a void take (session,
 * then lines), and it holds off a line going in meanwhile, whose insert takes
 * the same row FOR SHARE. Exported so a test can EXPLAIN it.
 */
export const openSessionOf = (tx: TenantTransaction, ctx: Tenant, tableId: string) =>
  tx
    .select({ id: tableSessions.id })
    .from(tableSessions)
    .where(
      and(
        eq(tableSessions.restaurantId, ctx.restaurantId),
        eq(tableSessions.tableId, tableId),
        eq(tableSessions.status, "open"),
      ),
    )
    .for("update");

/**
 * A session's items still in play, oldest order first, read from its orders
 * (orders_restaurant_id_session_id_placed_at_index) and their lines, so none of
 * the restaurant's history is read. Filtered on `in_play`, not on status (S-40
 * in detail). Exported so a test can EXPLAIN it.
 */
export const outstandingLines = (tx: TenantTransaction, ctx: Tenant, sessionId: string) =>
  tx
    .select({
      id: orderItems.id,
      name: orderItems.nameSnapshot,
      quantity: orderItems.quantity,
      status: orderItems.status,
      customerName: orders.customerName,
    })
    .from(orders)
    .innerJoin(
      orderItems,
      and(eq(orderItems.restaurantId, orders.restaurantId), eq(orderItems.orderId, orders.id)),
    )
    .where(
      and(
        eq(orders.restaurantId, ctx.restaurantId),
        eq(orders.sessionId, sessionId),
        eq(orderItems.inPlay, true),
      ),
    )
    .orderBy(asc(orders.placedAt), asc(orders.id), asc(orderItems.id));

class Refused<T> extends Error {
  constructor(readonly outcome: T) {
    super("refused");
  }
}

/** Runs a close in one transaction; a refusal rolls back whatever it did. */
async function attempt<T>(actor: Actor, run: (tx: TenantTransaction) => Promise<T>): Promise<T> {
  try {
    return await withTenant(actor, run);
  } catch (error) {
    if (error instanceof Refused) return error.outcome as T;
    // A Drizzle error's message quotes the statement's parameters: a force-close's reason.
    const cause = (error as { cause?: { code?: string } } | null)?.cause;
    throw new Error(`closing a session failed: ${cause?.code ?? "unknown"}`);
  }
}

/** The live table's open session, locked, if it is the one the page showed. */
async function shownSession(tx: TenantTransaction, actor: Actor, tableId: string, shown: string) {
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
  if (!table) throw new Refused({ outcome: "not_found" as const });
  const [session] = await openSessionOf(tx, actor, table.id);
  if (session?.id !== shown) throw new Refused({ outcome: "session_changed" as const });
  return session.id;
}

/** Closes the locked session. Closed by the actor's staff row: an entered admin's shadow row (S-29). */
const close = (
  tx: TenantTransaction,
  actor: Actor,
  sessionId: string,
  closeReason: "staff_clear" | "force_close",
) =>
  tx
    .update(tableSessions)
    .set({ status: "closed", closeReason, closedBy: actor.staffId, closedAt: sql`now()` })
    .where(and(eq(tableSessions.restaurantId, actor.restaurantId), eq(tableSessions.id, sessionId)));

/**
 * Clear table (spec 06): closes the table's open session when every item is
 * delivered or voided, with `staff_clear`, who and when. Otherwise it is refused
 * with the items in the way, and nothing changes. Not audited when staff do it,
 * since spec 01's audit list leaves it out; an entered platform admin's clear is
 * (`session.clear`), as every admin write is (S-28).
 */
export function clearTable(actor: Actor, tableId: string, shown: string): Promise<ClearOutcome> {
  return attempt(actor, async (tx) => {
    const sessionId = await shownSession(tx, actor, tableId, shown);
    const items = await outstandingLines(tx, actor, sessionId);
    if (items.length > 0) throw new Refused<ClearOutcome>({ outcome: "blocked", items });
    await close(tx, actor, sessionId, "staff_clear");
    await recordAdminAction(tx, actor, {
      action: "session.clear",
      entityType: "table_session",
      entityId: sessionId,
    });
    return { outcome: "done" } as const;
  });
}

/**
 * Force-close (spec 06, spec 00): voids every item of the table's open session
 * still in play with one reason, through the one void (voidLines, so each is
 * audited as `order_item.void`), then closes the session with `force_close`,
 * and audits `session.force_close` with the reason and the items it voided. All
 * in one transaction, so the closure gate sees the voids. A session with nothing
 * outstanding is closed all the same, voiding nothing.
 */
export function forceCloseTable(
  actor: Actor,
  tableId: string,
  shown: string,
  reason: string,
): Promise<ForceCloseOutcome> {
  return attempt(actor, async (tx) => {
    const sessionId = await shownSession(tx, actor, tableId, shown);
    const outstanding = (await outstandingLines(tx, actor, sessionId)).map((line) => line.id);
    const voided =
      outstanding.length === 0
        ? []
        : (await voidLines(tx, actor, inArray(orderItems.id, outstanding), reason)).map((line) => line.id);
    await close(tx, actor, sessionId, "force_close");
    await recordAudit(tx, actor, {
      action: "session.force_close",
      entityType: "table_session",
      entityId: sessionId,
      details: { reason, voided },
    });
    return { outcome: "done", voided } as const;
  });
}
