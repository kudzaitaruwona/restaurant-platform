import "server-only";
import { and, asc, count, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  diningTables,
  menuItems,
  orderItems,
  orders,
  restaurants,
  specials,
  tableSessions,
} from "@/db/schema";
import { localTime } from "@/lib/booking-engine";
import { latestRate } from "@/lib/exchange-rate";
import {
  effectiveUsd,
  effectiveZig,
  type Pricing,
  specialUsd,
  specialZig,
} from "@/lib/pricing";
import { resolvePublicToken } from "@/lib/tenant/public";
import { type TenantTransaction, withTenant } from "@/lib/tenant/scope";

/**
 * QR ordering for the customer (spec 06): everything a table's page does with
 * no session, keyed by the table's QR token and nothing else. The token names
 * the restaurant through the public seam (S-31), and the table is then found by
 * that token inside the restaurant, under RLS. Nothing from the request can name
 * a restaurant, a table or a session to write to.
 *
 * A public path, so it imports the tenant scope, never "@/lib/tenant", which
 * would load sign-in (S-32).
 */

/** The live table a token names, inside its restaurant: none once archived or regenerated. */
async function tableOf(tx: TenantTransaction, qrToken: string) {
  const [table] = await tx
    .select({ id: diningTables.id })
    .from(diningTables)
    .where(and(eq(diningTables.qrToken, qrToken), isNull(diningTables.archivedAt)));
  return table;
}

/**
 * A scan (spec 06): opens the table's session, or joins the one already open,
 * and either way marks it active now. One statement, so two phones scanning a
 * free table at once can't open two: the table lock
 * (table_sessions_one_open_per_table) makes the second wait for the first, then
 * join it. Undefined for a token that leads to no live table.
 */
export async function joinTableSession(qrToken: string) {
  const tenant = await resolvePublicToken("table", qrToken);
  if (!tenant) return undefined;
  return withTenant(tenant, async (tx) => {
    const table = await tableOf(tx, qrToken);
    if (!table) return undefined;
    const [session] = await tx
      .insert(tableSessions)
      .values({ restaurantId: tenant.restaurantId, tableId: table.id })
      .onConflictDoUpdate({
        target: tableSessions.tableId,
        targetWhere: sql`${tableSessions.status} = 'open'`,
        set: { lastActivityAt: sql`now()` },
      })
      .returning({ id: tableSessions.id });
    return { sessionId: session.id };
  });
}

/**
 * "Call a waiter" (spec 06, step 4, *proposed*, #77): flags the table's open
 * session, opening or joining one exactly as a scan does (one statement on the
 * table lock), and marks it active. A call already pending stays pending with its
 * first time: `coalesce` keeps it, so a hammered button is still one call and
 * can't push its own time forward. Undefined for a token that leads to no live
 * table. The flag is cleared by staff, or by the session closing (0043).
 */
export async function callWaiter(qrToken: string) {
  const tenant = await resolvePublicToken("table", qrToken);
  if (!tenant) return undefined;
  return withTenant(tenant, async (tx) => {
    const table = await tableOf(tx, qrToken);
    if (!table) return undefined;
    const [session] = await tx
      .insert(tableSessions)
      .values({ restaurantId: tenant.restaurantId, tableId: table.id, waiterRequestedAt: sql`now()` })
      .onConflictDoUpdate({
        target: tableSessions.tableId,
        targetWhere: sql`${tableSessions.status} = 'open'`,
        set: {
          lastActivityAt: sql`now()`,
          waiterRequestedAt: sql`coalesce(${tableSessions.waiterRequestedAt}, now())`,
        },
      })
      .returning({ id: tableSessions.id, requestedAt: tableSessions.waiterRequestedAt });
    return { sessionId: session.id, requestedAt: session.requestedAt! };
  });
}

// --- placing an order ---------------------------------------------------------

/**
 * The order rate limit *(proposed, S-40)*: a photographed code could otherwise
 * flood a kitchen. Per session, so a busy table of real customers is the only
 * thing it can slow down.
 */
export const ORDERS_PER_WINDOW = 10;
const WINDOW = "5 minutes";
const WINDOW_SECONDS = 300;

/** Most different items in one order *(proposed, S-40)*: a cart this big is a mistake or abuse. */
export const MAX_LINES = 20;

const messages = {
  name: "Enter a name for the waiter, up to 100 characters.",
  quantity: "Choose a quantity from 1 to 20.",
  note: "Keep the note to 200 characters.",
  item: "Choose an item from the menu.",
  lines: `Add 1 to ${MAX_LINES} items to your order.`,
  session: "Scan the code again, then place your order.",
};

/** One line of an order (spec 06): which item, how many, and a note for the kitchen. */
const orderLine = z.object({
  item: z.uuid(messages.item),
  quantity: z
    .string(messages.quantity)
    .regex(/^[0-9]{1,2}$/, messages.quantity)
    .transform(Number)
    .refine((n) => n >= 1 && n <= 20, messages.quantity),
  // Blank is no note.
  note: z
    .string()
    .trim()
    .max(200, messages.note)
    .optional()
    .transform((note) => note || null),
});

/**
 * Everything an order request may say (spec 06): up to 20 lines, the customer's
 * name, and the session the page joined, which is only compared with the table's
 * open session, never used to find one. Anything else in the request, a price, a
 * rate or a restaurant, is never read.
 */
const orderRequest = z.object({
  lines: z.array(orderLine).min(1, messages.lines).max(MAX_LINES, messages.lines),
  name: z.string(messages.name).trim().min(1, messages.name).max(100, messages.name),
  session: z.uuid(messages.session),
});

export type OrderRequest = z.output<typeof orderRequest>;

/**
 * A form carries the lines as repeated `item`, `quantity` and `note` fields, line
 * by line in step. The notes may all be left out; any other mismatch is a bad
 * request, not a guess about which note belongs to which item.
 */
function formLines(form: FormData) {
  const items = form.getAll("item");
  const quantities = form.getAll("quantity");
  const notes = form.getAll("note");
  if (quantities.length !== items.length) return [];
  if (notes.length !== 0 && notes.length !== items.length) return [];
  return items.map((item, index) => ({
    item,
    quantity: quantities[index],
    note: notes.length === 0 ? undefined : notes[index],
  }));
}

export const parseOrderRequest = (form: FormData) => {
  const result = orderRequest.safeParse({
    lines: formLines(form),
    name: form.get("name") ?? undefined,
    session: form.get("session") ?? undefined,
  });
  return result.success
    ? ({ success: true, data: result.data } as const)
    : ({ success: false, message: result.error.issues[0].message } as const);
};

export type OrderOutcome =
  | { outcome: "placed"; placed: { lines: { name: string; quantity: number }[] } }
  | { outcome: "no_table" }
  | { outcome: "session_changed" }
  | { outcome: "unavailable"; item: string }
  | { outcome: "rate_limited"; retryAfterSeconds: number };

/** Thrown inside the transaction so that a refusal rolls back whatever it had written. */
class Refused extends Error {
  constructor(readonly outcome: Exclude<OrderOutcome, { outcome: "placed" }>) {
    super(outcome.outcome);
  }
}

/**
 * What each line freezes (spec 06), worked out from the database at the moment
 * of the order, with the same functions the menu shows prices with: the special
 * live now, if any, by spec 00's precedence, else the item's own prices. One
 * rate and one set of rounding steps for the whole order. Four reads whatever
 * the number of items, since they run while the session's row is held. An item
 * that can't be ordered now (archived, sold out, another restaurant's, which
 * RLS hides, or a bundle outside its special's window) is missing from the map.
 */
async function pricedItems(tx: TenantTransaction, restaurantId: string, itemIds: string[]) {
  const [steps] = await tx
    .select({ zigStep: restaurants.zigRoundingStep, usdStep: restaurants.usdRoundingStep })
    .from(restaurants)
    .where(eq(restaurants.id, restaurantId));
  const rate = (await latestRate(tx, restaurantId))?.usdToZig ?? null;
  const pricing: Pricing = { rate, ...steps };
  const items = await tx
    .select({
      id: menuItems.id,
      name: menuItems.name,
      priceUsd: menuItems.priceUsd,
      priceZig: menuItems.priceZig,
      visibility: menuItems.visibility,
    })
    .from(menuItems)
    .where(
      and(
        eq(menuItems.restaurantId, restaurantId),
        inArray(menuItems.id, itemIds),
        isNull(menuItems.archivedAt),
        eq(menuItems.available, true),
      ),
    );
  // D-05 means at most one per item.
  const specialOf = new Map(
    (
      await tx
        .select({
          menuItemId: specials.menuItemId,
          id: specials.id,
          priceUsd: specials.specialPriceUsd,
          priceZig: specials.specialPriceZig,
        })
        .from(specials)
        .where(
          and(
            eq(specials.restaurantId, restaurantId),
            inArray(specials.menuItemId, itemIds),
            eq(specials.active, true),
            or(isNull(specials.startsAt), lte(specials.startsAt, sql`now()`)),
            or(isNull(specials.endsAt), gt(specials.endsAt, sql`now()`)),
          ),
        )
    ).map((special) => [special.menuItemId, special]),
  );

  const priced = new Map<string, PricedItem>();
  for (const item of items) {
    const special = specialOf.get(item.id);
    if (item.visibility === "special_only" && !special) continue;
    const zig = special ? specialZig(item, special, pricing) : effectiveZig(item, pricing);
    priced.set(item.id, {
      name: item.name,
      specialId: special?.id ?? null,
      unitPriceUsd: special ? specialUsd(item, special, pricing) : effectiveUsd(item, pricing),
      unitPriceZig: zig?.amount ?? null,
      zigSource: zig?.source ?? null,
    });
  }
  return { rate, priced };
}

type PricedItem = {
  name: string;
  specialId: string | null;
  unitPriceUsd: string | null;
  unitPriceZig: string | null;
  zigSource: "fixed" | "calculated" | null;
};

/**
 * Places an order (spec 06), one or more lines, into the open session of the table the token names,
 * in one transaction, so a refusal writes nothing. The session is found by the
 * token: the one the page says it joined must be that session, or the order is
 * refused, so a stale tab can't order into a new party's session. Taking the
 * session's row (to mark it active) also queues orders for one session behind
 * each other, so the rate limit's count can't be raced.
 */
export async function placeOrder(qrToken: string, request: OrderRequest): Promise<OrderOutcome> {
  const tenant = await resolvePublicToken("table", qrToken);
  if (!tenant) return { outcome: "no_table" };
  const { restaurantId } = tenant;
  try {
    return await withTenant(tenant, async (tx) => {
      const table = await tableOf(tx, qrToken);
      if (!table) throw new Refused({ outcome: "no_table" });

      const [session] = await tx
        .update(tableSessions)
        .set({ lastActivityAt: sql`now()` })
        .where(and(eq(tableSessions.tableId, table.id), eq(tableSessions.status, "open")))
        .returning({ id: tableSessions.id });
      if (session?.id !== request.session) throw new Refused({ outcome: "session_changed" });

      const [recent] = await tx
        .select({
          count: count(),
          retryAfter: sql<number | null>`ceil(extract(epoch from min(${orders.placedAt}) + ${WINDOW}::interval - now()))::int`,
        })
        .from(orders)
        .where(
          and(
            eq(orders.restaurantId, restaurantId),
            eq(orders.sessionId, session.id),
            gt(orders.placedAt, sql`now() - ${WINDOW}::interval`),
          ),
        );
      if (recent.count >= ORDERS_PER_WINDOW) {
        throw new Refused({
          outcome: "rate_limited",
          retryAfterSeconds: Math.min(Math.max(recent.retryAfter ?? WINDOW_SECONDS, 1), WINDOW_SECONDS),
        });
      }

      // Each distinct item once: a line for the same dish with another note shares its price.
      const { rate, priced: pricedById } = await pricedItems(
        tx,
        restaurantId,
        [...new Set(request.lines.map((line) => line.item))],
      );
      const unavailable = request.lines.find((line) => !pricedById.has(line.item));
      if (unavailable) throw new Refused({ outcome: "unavailable", item: unavailable.item });

      const [order] = await tx
        .insert(orders)
        .values({
          restaurantId,
          sessionId: session.id,
          customerName: request.name,
          rateUsed: rate,
        })
        .returning({ id: orders.id });
      await tx.insert(orderItems).values(
        request.lines.map((line) => {
          const priced = pricedById.get(line.item)!;
          return {
            restaurantId,
            orderId: order.id,
            menuItemId: line.item,
            specialId: priced.specialId,
            nameSnapshot: priced.name,
            quantity: line.quantity,
            unitPriceUsd: priced.unitPriceUsd,
            unitPriceZig: priced.unitPriceZig,
            zigSource: priced.zigSource,
            note: line.note,
          };
        }),
      );
      return {
        outcome: "placed" as const,
        placed: {
          lines: request.lines.map((line) => ({
            name: pricedById.get(line.item)!.name,
            quantity: line.quantity,
          })),
        },
      };
    });
  } catch (error) {
    if (error instanceof Refused) return error.outcome;
    throw error;
  }
}

// --- the order tracker ------------------------------------------------------------

/**
 * What the table's page polls for (spec 06, step 3): the open session of the
 * table the token names, and every item in it, for every phone at the table.
 * Nothing from a closed session, another table or another restaurant, because
 * the session is found from the token (a table, then its one open session) and
 * the items from that session alone. A pure read, with no activity bump: a phone
 * left open on a table shouldn't keep its session from idling out.
 *
 * Each poll is the token's lookup, then one read joining the table, its open
 * session and the restaurant's timezone, then one read of the items by session
 * (an indexed read, orders_restaurant_id_session_id_placed_at_index). It carries
 * only what the customer sees: never a void reason or who voided, nor an id.
 * Times are on the restaurant's clock. No session is `{ session: null }`: the
 * page says the table's session has ended. Undefined for a token that leads to
 * no live table.
 */
export async function getTableTracker(qrToken: string) {
  const tenant = await resolvePublicToken("table", qrToken);
  if (!tenant) return undefined;
  return withTenant(tenant, async (tx) => {
    const [table] = await tx
      .select({ sessionId: tableSessions.id, timezone: restaurants.timezone })
      .from(diningTables)
      .innerJoin(restaurants, eq(restaurants.id, diningTables.restaurantId))
      .leftJoin(
        tableSessions,
        and(
          eq(tableSessions.restaurantId, diningTables.restaurantId),
          eq(tableSessions.tableId, diningTables.id),
          eq(tableSessions.status, "open"),
        ),
      )
      .where(and(eq(diningTables.qrToken, qrToken), isNull(diningTables.archivedAt)));
    if (!table) return undefined;
    if (!table.sessionId) return { session: null, items: [] };

    const rows = await tx
      .select({
        quantity: orderItems.quantity,
        name: orderItems.nameSnapshot,
        note: orderItems.note,
        status: orderItems.status,
        customer: orders.customerName,
        placedAt: orders.placedAt,
      })
      .from(orderItems)
      .innerJoin(
        orders,
        and(eq(orders.restaurantId, orderItems.restaurantId), eq(orders.id, orderItems.orderId)),
      )
      .where(and(eq(orders.restaurantId, tenant.restaurantId), eq(orders.sessionId, table.sessionId)))
      .orderBy(asc(orders.placedAt), asc(orderItems.id));
    return {
      session: table.sessionId,
      items: rows.map(({ placedAt, ...row }) => ({ ...row, time: localTime(placedAt, table.timezone) })),
    };
  });
}
