import "server-only";
import { and, asc, eq, gte, inArray, sql, type SQL } from "drizzle-orm";
import { diningTables, orderItems, orders, tableSessions } from "@/db/schema";
import { type BoardItem, type ItemStatus, isMove } from "@/lib/kitchen-board";
import { recordAudit } from "@/lib/tenant/audit";
import { type TenantContext, type TenantTransaction, withTenant } from "@/lib/tenant/scope";

/**
 * The kitchen board's data (spec 07), for owner and staff alike (S-26): the
 * lines in play with their table and who ordered them, the changes since the
 * last poll, and the one-step moves.
 */

type Restaurant = Pick<TenantContext, "restaurantId">;

/**
 * Where the next poll starts: the oldest transaction still running (the
 * snapshot's xmin), as a decimal string. Read BEFORE the rows it goes with, in a
 * statement of its own: any write the read that follows can't see is by a
 * transaction running now or started since, so its id, and the stamp it puts on
 * its rows (order_items_change_stamp), is at or above this. Asking for stamps
 * `>=` it next time can return a row twice, never miss one. The board applies
 * rows by id, so twice is harmless.
 */
async function cursorOf(tx: TenantTransaction) {
  const { rows } = await tx.execute<{ cursor: string; now: string }>(
    sql`select pg_snapshot_xmin(pg_current_snapshot())::text as cursor, now() as now`,
  );
  return { cursor: rows[0].cursor, now: new Date(rows[0].now).toISOString() };
}

const boardItemColumns = {
  id: orderItems.id,
  orderId: orderItems.orderId,
  table: diningTables.label,
  quantity: orderItems.quantity,
  name: orderItems.nameSnapshot,
  note: orderItems.note,
  customerName: orders.customerName,
  placedAt: orders.placedAt,
  status: orderItems.status,
  statusChangedAt: orderItems.statusChangedAt,
};

/** The query for the lines of the restaurant matching `where`, with their order and table. */
function boardQuery(tx: TenantTransaction, ctx: Restaurant, where: SQL | undefined) {
  return tx
    .select(boardItemColumns)
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
    .where(and(eq(orderItems.restaurantId, ctx.restaurantId), where))
    .orderBy(asc(orders.placedAt), asc(orderItems.id));
}

const toBoardItems = (rows: Awaited<ReturnType<typeof boardQuery>>) =>
  rows.map(
    (row): BoardItem => ({
      ...row,
      placedAt: row.placedAt.toISOString(),
      statusChangedAt: row.statusChangedAt.toISOString(),
    }),
  );

/** Lines of the restaurant matching `where`, with their order and table. */
async function boardItems(tx: TenantTransaction, ctx: Restaurant, where: SQL | undefined) {
  return toBoardItems(await boardQuery(tx, ctx, where));
}

/**
 * The lines the board shows: placed, cooking and done, as the generated
 * `in_play` column says, not a filter on status. As app_tenant, under RLS,
 * Postgres can't use status's statistics (the enum's comparisons aren't
 * leakproof), so a status filter, `in` or `not in`, is estimated as most of the
 * restaurant's lines. A boolean's equality is leakproof, so in_play's estimate
 * is the share of lines in play across every restaurant.
 */
const onTheBoard = sql`${orderItems.inPlay}`;

/**
 * The ids of the board's lines, read alone, on the order_items_in_play partial
 * index: the lines in play, and none of the restaurant's history. Exported, with
 * boardLinesOf, so a test can EXPLAIN exactly what the board sends.
 */
export const boardLineIds = (tx: TenantTransaction, ctx: Restaurant) =>
  tx
    .select({ id: orderItems.id })
    .from(orderItems)
    .where(and(eq(orderItems.restaurantId, ctx.restaurantId), onTheBoard));

/** The board's lines with their order and table, from the ids boardLineIds read. */
export const boardLinesOf = (tx: TenantTransaction, ctx: Restaurant, ids: string[]) =>
  boardQuery(tx, ctx, and(inArray(orderItems.id, ids), onTheBoard));

/**
 * The whole board: every placed, cooking and done line, with the cursor for the
 * first poll and the server's clock, which ages the cards. In two reads: the
 * ids of the lines in play, then those lines by id with their orders and tables.
 * One join filtered on in_play would leave the join's plan to that estimate,
 * which is the share of lines in play across every restaurant times this
 * restaurant's history: for a restaurant with a long history it comes out large
 * enough that Postgres hash-joins every order the restaurant ever took. Given
 * the ids, the second read is estimated at their number, so it fetches each
 * line's order by its key. kitchen.int.test.ts measures both on a restaurant
 * with history. A line that leaves the board between the two reads is left out
 * by the second; the cursor, read first, brings the change in the next poll.
 */
export function getBoard(ctx: Restaurant) {
  return withTenant(ctx, async (tx) => {
    const { cursor, now } = await cursorOf(tx);
    const ids = (await boardLineIds(tx, ctx)).map((line) => line.id);
    const items = ids.length === 0 ? [] : toBoardItems(await boardLinesOf(tx, ctx, ids));
    return { cursor, now, items };
  });
}

/**
 * The lines written since `since` (a cursor a previous read gave), in any
 * status, so a delivered or voided line reaches the board to be dropped. Read on
 * order_items_changes.
 */
export function getChanges(ctx: Restaurant, since: string) {
  return withTenant(ctx, async (tx) => {
    const { cursor, now } = await cursorOf(tx);
    const items = await boardItems(tx, ctx, gte(orderItems.changeXid, Number(since)));
    return { cursor, now, items };
  });
}

/** A cursor as a poll sends it back: digits only, as cursorOf writes it. */
export const isCursor = (value: string) => /^\d{1,15}$/.test(value);

export type MoveOutcome =
  | { outcome: "done"; item: BoardItem }
  | { outcome: "not_found" }
  /** Not a one-step move from the status the line is in now: skipped, or someone moved it first. */
  | { outcome: "wrong_status"; status: ItemStatus };

class Refused extends Error {
  constructor(readonly outcome: Exclude<MoveOutcome, { outcome: "done" }>) {
    super(outcome.outcome);
  }
}

/**
 * One step forward or back (spec 07), from the status the board showed. The
 * session's row is taken first, by the activity bump (spec 06: an item status
 * change is activity), in the order placing an order takes them (session, then
 * lines). Then `WHERE status = from` makes two tablets tapping at once one
 * winner. A refusal rolls the bump back with it and writes no audit entry.
 * Every move is audited, with who made it, from and to.
 */
export async function moveItem(
  actor: Pick<TenantContext, "restaurantId" | "staffId" | "platformAdminId">,
  itemId: string,
  from: ItemStatus,
  to: ItemStatus,
): Promise<MoveOutcome> {
  try {
    return await withTenant(actor, async (tx) => {
      const where = and(eq(orderItems.restaurantId, actor.restaurantId), eq(orderItems.id, itemId));
      const [line] = await tx
        .select({ status: orderItems.status, sessionId: orders.sessionId })
        .from(orderItems)
        .innerJoin(
          orders,
          and(eq(orders.restaurantId, orderItems.restaurantId), eq(orders.id, orderItems.orderId)),
        )
        .where(where);
      if (!line) throw new Refused({ outcome: "not_found" });
      if (!isMove(from, to)) throw new Refused({ outcome: "wrong_status", status: line.status });

      await tx
        .update(tableSessions)
        .set({ lastActivityAt: sql`now()` })
        .where(
          and(
            eq(tableSessions.restaurantId, actor.restaurantId),
            eq(tableSessions.id, line.sessionId),
            eq(tableSessions.status, "open"),
          ),
        );
      const moved = await tx
        .update(orderItems)
        .set({ status: to, statusChangedAt: sql`now()` })
        .where(and(where, eq(orderItems.status, from)))
        .returning({ id: orderItems.id });
      if (moved.length === 0) {
        const [current] = await tx.select({ status: orderItems.status }).from(orderItems).where(where);
        throw new Refused({ outcome: "wrong_status", status: current.status });
      }
      await recordAudit(tx, actor, {
        action: "order_item.status",
        entityType: "order_item",
        entityId: itemId,
        details: { from, to },
      });
      const [item] = await boardItems(tx, actor, eq(orderItems.id, itemId));
      return { outcome: "done", item } as const;
    });
  } catch (error) {
    if (error instanceof Refused) return error.outcome;
    // A Drizzle error's message quotes the statement's parameters.
    const cause = (error as { cause?: { code?: string } } | null)?.cause;
    throw new Error(`moving a kitchen item failed: ${cause?.code ?? "unknown"}`);
  }
}
