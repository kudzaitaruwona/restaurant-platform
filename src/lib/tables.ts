import "server-only";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { notFound } from "next/navigation";
import { z } from "zod";
import { diningTables, restaurants } from "@/db/schema";
import { revalidateMenu } from "@/lib/menu-cache";
import { mintQrToken } from "@/lib/qr-token";
import { recordAdminAction, recordAudit } from "@/lib/tenant/audit";
import { type TenantContext, withTenant } from "@/lib/tenant/scope";

/**
 * Tables and their QR codes (spec 03). Writes are owner only (S-26): callers
 * check requireOwner(ctx). Spec 01's audit list doesn't include adding a table,
 * so only a platform admin's are audited.
 */

type Tenant = Pick<TenantContext, "restaurantId">;
type Writer = Tenant & Pick<TenantContext, "platformAdminId">;

/** The partial unique index that refuses a label already on a live table. */
const LABEL_INDEX = "tables_restaurant_id_label_unique";

const messages = {
  label: "Enter the table's label, up to 50 characters.",
  capacity: "Enter how many people the table seats, from 1 to 100.",
  labelTaken: "Another table already has that label.",
  bookable: "Choose whether the table can be booked online.",
};

// Messages are fixed strings, so a refused value is never echoed back.
const newTable = z.object({
  label: z
    .string(messages.label)
    .trim()
    .min(1, messages.label)
    .max(50, messages.label),
  // Digits only: Number("1e1") and Number("0x10") would pass as numbers.
  capacity: z
    .string(messages.capacity)
    .trim()
    .regex(/^[0-9]{1,3}$/, messages.capacity)
    .transform(Number)
    .refine((n) => n >= 1 && n <= 100, messages.capacity),
});

export type NewTable = z.output<typeof newTable>;

export const parseNewTable = (form: FormData) => {
  const result = newTable.safeParse(Object.fromEntries(form));
  return result.success
    ? ({ success: true, data: result.data } as const)
    : ({ success: false, message: result.error.issues[0].message } as const);
};

export const labelTakenMessage = messages.labelTaken;

const tableEdit = newTable.extend({
  // The form sends "false" first and "true" after it when the box is ticked,
  // and the last of a repeated field wins.
  bookable: z.enum(["true", "false"], messages.bookable).transform((v) => v === "true"),
});

export type TableEdit = z.output<typeof tableEdit>;

export const parseTableEdit = (form: FormData) => {
  const result = tableEdit.safeParse(Object.fromEntries(form));
  return result.success
    ? ({ success: true, data: result.data } as const)
    : ({ success: false, message: result.error.issues[0].message } as const);
};

export const parseDirection = (form: FormData) =>
  z.enum(["up", "down"]).safeParse(form.get("direction"));

/** The id in a table route. A malformed one is a 404, like an unknown one. */
export async function tableIdFrom(params: Promise<{ tableId: string }>) {
  const parsed = z.uuid().safeParse((await params).tableId);
  if (!parsed.success) notFound();
  return parsed.data;
}

const constraintOf = (error: unknown) =>
  (error as { cause?: { constraint?: unknown } } | null)?.cause?.constraint;

/**
 * Adds a table at the end of the list, with the token that lets customers scan
 * to it. The partial unique index is what refuses a label already on a live
 * table, so two owners adding "7" together can't both win.
 */
export async function addTable(
  ctx: Writer,
  table: NewTable,
): Promise<"saved" | "label_taken"> {
  const { restaurantId } = ctx;
  try {
    await withTenant(ctx, async (tx) => {
      const [added] = await tx
        .insert(diningTables)
        .values({
          ...table,
          restaurantId,
          qrToken: mintQrToken(),
          sortOrder: sql`(
            select coalesce(max(${diningTables.sortOrder}), -1) + 1 from ${diningTables}
            where ${eq(diningTables.restaurantId, restaurantId)}
          )`,
        })
        .returning({ id: diningTables.id });
      await recordAdminAction(tx, ctx, {
        action: "table.create",
        entityType: "table",
        entityId: added.id,
      });
    });
  } catch (error) {
    if (constraintOf(error) === LABEL_INDEX) return "label_taken";
    throw error;
  }
  return "saved";
}

export type TableChange = "saved" | "not_found";

/** One live table of the restaurant: an archived one is as good as gone. */
const live = (restaurantId: string, tableId: string) =>
  and(
    eq(diningTables.restaurantId, restaurantId),
    eq(diningTables.id, tableId),
    isNull(diningTables.archivedAt),
  );

/**
 * Edits a table's label, capacity and bookable flag. A capacity change reaches
 * bookings made from now on only: a booking keeps the table it has.
 */
export async function updateTable(
  ctx: Writer,
  tableId: string,
  edit: TableEdit,
): Promise<TableChange | "label_taken"> {
  try {
    return await withTenant(ctx, async (tx) => {
      const updated = await tx
        .update(diningTables)
        .set(edit)
        .where(live(ctx.restaurantId, tableId))
        .returning({ id: diningTables.id });
      if (updated.length === 0) return "not_found";
      await recordAdminAction(tx, ctx, {
        action: "table.update",
        entityType: "table",
        entityId: tableId,
      });
      return "saved";
    });
  } catch (error) {
    if (constraintOf(error) === LABEL_INDEX) return "label_taken";
    throw error;
  }
}

/**
 * Moves a table one place up or down the list. The live tables are numbered
 * afresh from 0 first, so ties and the gaps archiving leaves can't make a move
 * do nothing; the rows are locked so two moves can't both start from the old order.
 */
export function moveTable(
  ctx: Writer,
  tableId: string,
  direction: "up" | "down",
): Promise<TableChange> {
  return withTenant(ctx, async (tx) => {
    const tables = await tx
      .select({ id: diningTables.id, sortOrder: diningTables.sortOrder })
      .from(diningTables)
      .where(
        and(
          eq(diningTables.restaurantId, ctx.restaurantId),
          isNull(diningTables.archivedAt),
        ),
      )
      .orderBy(asc(diningTables.sortOrder), asc(diningTables.label))
      .for("update");
    const from = tables.findIndex(({ id }) => id === tableId);
    if (from === -1) return "not_found";

    const to = from + (direction === "up" ? -1 : 1);
    const order = tables.map(({ id }) => id);
    if (to >= 0 && to < order.length) [order[from], order[to]] = [order[to], order[from]];

    for (const [position, id] of order.entries()) {
      const current = tables.find((table) => table.id === id)!.sortOrder;
      if (current === position) continue;
      await tx
        .update(diningTables)
        .set({ sortOrder: position })
        .where(and(eq(diningTables.restaurantId, ctx.restaurantId), eq(diningTables.id, id)));
    }
    await recordAdminAction(tx, ctx, {
      action: "table.reorder",
      entityType: "table",
      entityId: tableId,
      details: { direction },
    });
    return "saved";
  });
}

/**
 * Archives a table: off the list and the print sheet, and its printed code
 * stops working. The label is free to use again. A found /t/ page is cached, so
 * the menu's cache is refreshed once this has committed.
 */
export async function archiveTable(ctx: Writer, tableId: string): Promise<TableChange> {
  const outcome = await withTenant(ctx, async (tx) => {
    const archived = await tx
      .update(diningTables)
      .set({ archivedAt: sql`now()` })
      .where(live(ctx.restaurantId, tableId))
      .returning({ id: diningTables.id });
    if (archived.length === 0) return "not_found";
    await recordAdminAction(tx, ctx, {
      action: "table.archive",
      entityType: "table",
      entityId: tableId,
    });
    return "saved";
  });
  if (outcome === "saved") revalidateMenu(ctx);
  return outcome;
}

/**
 * Gives a live table a new token, so the printed code stops working at once
 * (spec 03). The old token is not kept anywhere: it resolves to nothing, so its
 * scan gets the out-of-date page, which is also why that page has no menu link.
 * On spec 01's audit list, so an owner's is audited too. Neither token is ever
 * logged or put in the entry. The page is cached under the restaurant's tag with
 * the old token as its key, so that tag is expired once this has committed.
 */
export async function regenerateQrToken(
  ctx: Tenant & Pick<TenantContext, "staffId" | "platformAdminId">,
  tableId: string,
): Promise<"done" | "not_found"> {
  const outcome = await withTenant(ctx, async (tx) => {
    const [table] = await tx
      .update(diningTables)
      .set({ qrToken: mintQrToken(), tokenRotatedAt: sql`now()` })
      .where(
        and(
          eq(diningTables.restaurantId, ctx.restaurantId),
          eq(diningTables.id, tableId),
          isNull(diningTables.archivedAt),
        ),
      )
      .returning({ id: diningTables.id, label: diningTables.label });
    if (!table) return "not_found" as const;
    await recordAudit(tx, ctx, {
      action: "table.regenerate_qr",
      entityType: "table",
      entityId: table.id,
      details: { label: table.label },
    });
    return "done" as const;
  });
  if (outcome === "done") revalidateMenu(ctx);
  return outcome;
}

/** A restaurant's live tables, in the order staff set. */
export function listTables(ctx: Tenant) {
  const { restaurantId } = ctx;
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: diningTables.id,
        label: diningTables.label,
        capacity: diningTables.capacity,
        bookable: diningTables.bookable,
        qrToken: diningTables.qrToken,
      })
      .from(diningTables)
      .where(
        and(
          eq(diningTables.restaurantId, restaurantId),
          isNull(diningTables.archivedAt),
        ),
      )
      .orderBy(asc(diningTables.sortOrder), asc(diningTables.label)),
  );
}

/** What a printed card says besides the table: whose it is, the Wi-Fi, and the menu link for the generic card. */
export function getPrintHeader(ctx: Tenant) {
  const { restaurantId } = ctx;
  return withTenant(ctx, async (tx) => {
    const [restaurant] = await tx
      .select({
        name: restaurants.name,
        wifiName: restaurants.wifiName,
        wifiPassword: restaurants.wifiPassword,
        menuToken: restaurants.menuToken,
      })
      .from(restaurants)
      .where(eq(restaurants.id, restaurantId));
    return restaurant;
  });
}
