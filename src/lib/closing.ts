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

/**
 * How long after its close a session can be reopened (spec 06, Sessions; S-20).
 * Postgres holds the rule itself (trigger table_sessions_reopen, migration 0048,
 * which has the same 15 minutes); this is for what the floor offers and says.
 */
export const REOPEN_WINDOW_MINUTES = 15;

export type ReopenOutcome =
  | { outcome: "done" }
  | { outcome: "not_found" }
  /** Not a closed session of this table any more: reopened already, or never this table's. */
  | { outcome: "session_changed" }
  /** More than 15 minutes since it closed: a scan starts a fresh session instead. */
  | { outcome: "too_late" }
  /** A new party has opened the table since, whether still there or gone. */
  | { outcome: "superseded" };

/**
 * The table's latest session, by when it opened, with whether it closed within
 * the reopen window on Postgres's clock: what the table's detail offers to
 * reopen. Only the latest can be reopened, since any other has a session that
 * opened after it. Found by table_latest_session (migration 0048), the reopen
 * rule's own probe: one entry at the newest end of table_sessions_table_opened,
 * with its plan pinned, so none of the table's past is read on any statistics;
 * then that session by its key. Exported so a test can measure it.
 */
export const lastSessionOf = (tx: TenantTransaction, ctx: Tenant, tableId: string) =>
  tx
    .select({
      id: tableSessions.id,
      status: tableSessions.status,
      closedAt: tableSessions.closedAt,
      closeReason: tableSessions.closeReason,
      inWindow: sql<boolean>`coalesce(${tableSessions.closedAt} > now() - make_interval(mins => ${REOPEN_WINDOW_MINUTES}), false)`,
    })
    .from(tableSessions)
    .where(sql`${tableSessions.id} = table_latest_session(${ctx.restaurantId}::uuid, ${tableId}::uuid)`);

/**
 * The session the page offered to reopen, locked, so two reopens at once queue
 * and the second finds it open. Keyed by its id only, the tenant held by RLS:
 * with the restaurant (or the table) in the filter too, Postgres on stale
 * statistics served it from table_sessions_table_opened, reading the table's
 * whole history (EXPLAIN-tested). The caller checks the table. Exported so a
 * test can EXPLAIN it.
 */
export const sessionToReopen = (tx: TenantTransaction, sessionId: string) =>
  tx
    .select({
      tableId: tableSessions.tableId,
      status: tableSessions.status,
      closedAt: tableSessions.closedAt,
      closeReason: tableSessions.closeReason,
    })
    .from(tableSessions)
    .where(eq(tableSessions.id, sessionId))
    .for("update");

/**
 * The reopen itself, keyed by the session's id only, like sessionToReopen; RLS
 * holds it to the tenant. Exported so a test can measure what it reads, the
 * trigger's probe included.
 */
export const reopening = (tx: TenantTransaction, sessionId: string) =>
  tx
    .update(tableSessions)
    .set({ status: "open", closedAt: null, closeReason: null, closedBy: null, lastActivityAt: sql`now()` })
    .where(eq(tableSessions.id, sessionId));

/** The reopen rule's refusals (0048) and the table lock's, as outcomes. Anything else is rethrown. */
function refusalOf(error: unknown): ReopenOutcome | undefined {
  const cause = (error as { cause?: { code?: string; constraint?: string } } | null)?.cause;
  if (cause?.constraint === "table_sessions_reopen_window") return { outcome: "too_late" };
  // Another party has opened the table since; or one is opening it right now and
  // holds the table lock, which the reopen waited on and then lost.
  if (cause?.constraint === "table_sessions_reopen_newer_session") return { outcome: "superseded" };
  if (cause?.code === "23505" && cause.constraint === "table_sessions_one_open_per_table") {
    return { outcome: "superseded" };
  }
  return undefined;
}

/**
 * Reopen (spec 06, Sessions; S-20): staff reopen a closed session from the
 * table's detail, within 15 minutes of its close and only if no session has
 * opened on the table since, even one that has closed again. Postgres decides
 * (trigger table_sessions_reopen, 0048, and the table lock), so a reopen racing a
 * scan either wins, and the scan joins it, or is refused. Reopening forgets the
 * close and resets last_activity_at (the trigger does both whoever writes; set
 * here too so the statement says what it means). Audited as `session.reopen`
 * with when and how it had closed (spec 01), for owner and staff alike (S-26).
 */
export function reopenSession(actor: Actor, tableId: string, sessionId: string): Promise<ReopenOutcome> {
  return attempt(actor, async (tx) => {
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
    if (!table) throw new Refused<ReopenOutcome>({ outcome: "not_found" });
    const [session] = await sessionToReopen(tx, sessionId);
    if (session?.tableId !== table.id || session.status !== "closed") {
      throw new Refused<ReopenOutcome>({ outcome: "session_changed" });
    }
    try {
      await reopening(tx, sessionId);
    } catch (error) {
      const refusal = refusalOf(error);
      if (refusal) throw new Refused(refusal);
      throw error;
    }
    await recordAudit(tx, actor, {
      action: "session.reopen",
      entityType: "table_session",
      entityId: sessionId,
      details: { closedAt: session.closedAt?.toISOString() ?? null, closeReason: session.closeReason },
    });
    return { outcome: "done" } as const;
  });
}
