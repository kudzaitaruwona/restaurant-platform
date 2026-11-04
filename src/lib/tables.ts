import "server-only";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { diningTables, restaurants } from "@/db/schema";
import { mintQrToken } from "@/lib/qr-token";
import { recordAdminAction } from "@/lib/tenant/audit";
import { type TenantContext, withTenant } from "@/lib/tenant/scope";

/**
 * Tables and their QR codes (spec 03). Writes are owner only (S-26): callers
 * check requireOwner(ctx). Spec 01's audit list doesn't include adding a table,
 * so only a platform admin's are audited.
 */

type Tenant = Pick<TenantContext, "restaurantId">;
type Writer = Tenant & Pick<TenantContext, "platformAdminId">;

const UNIQUE_VIOLATION = "23505";

const messages = {
  label: "Enter the table's label, up to 50 characters.",
  capacity: "Enter how many people the table seats, from 1 to 100.",
  labelTaken: "Another table already has that label.",
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
    const { code } = (error as { cause?: { code?: string } }).cause ?? {};
    if (code === UNIQUE_VIOLATION) return "label_taken";
    throw error;
  }
  return "saved";
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
