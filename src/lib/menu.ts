import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { categories, menuItems, restaurants } from "@/db/schema";
import { latestRate } from "@/lib/exchange-rate";
import { revalidateMenu } from "@/lib/menu-cache";
import { recordAdminAction } from "@/lib/tenant/audit";
import { type TenantContext, withTenant } from "@/lib/tenant/scope";

/**
 * The menu (spec 02). Writes are owner only (S-26): callers check
 * requireOwner(ctx). A public route reads this too, so it imports the tenant
 * scope rather than "@/lib/tenant", which would load sign-in (S-32).
 *
 * Every write here calls revalidateMenu, so a route can't forget to. Spec 01's
 * audit list doesn't include menu edits, so only a platform admin's are audited.
 */

type Tenant = Pick<TenantContext, "restaurantId">;
type Writer = Tenant & Pick<TenantContext, "platformAdminId">;

const FOREIGN_KEY_VIOLATION = "23503";

const messages = {
  categoryName: "Enter the category's name, up to 200 characters.",
  itemName: "Enter the item's name, up to 200 characters.",
  description: "Enter a description of up to 1000 characters.",
  priceUsd: "Enter the USD price as a number, like 8.50.",
  priceZig: "Enter the ZiG price as a number, like 210.",
  price: "Enter a USD price, a ZiG price, or both.",
  category: "Choose a category.",
};

// Messages are fixed strings, so a refused value is never echoed back.
const newCategory = z.object({
  name: z
    .string(messages.categoryName)
    .trim()
    .min(1, messages.categoryName)
    .max(200, messages.categoryName),
});

// A price field left blank is no price. Postgres would also take 1e3, NaN and
// Infinity as numeric, so the spelling is checked here.
const optionalPrice = (pattern: RegExp, message: string) =>
  z.preprocess(
    (value) => (value === undefined ? "" : value),
    z
      .string(message)
      .trim()
      .refine((value) => value === "" || pattern.test(value), message)
      .transform((value) => value || null),
  );

const newMenuItem = z
  .object({
    name: z
      .string(messages.itemName)
      .trim()
      .min(1, messages.itemName)
      .max(200, messages.itemName),
    description: z
      .string(messages.description)
      .trim()
      .max(1000, messages.description),
    priceUsd: optionalPrice(/^[0-9]{1,6}(\.[0-9]{1,2})?$/, messages.priceUsd),
    // Set means a fixed ZiG price. Blank means calculated from the rate (S-10).
    priceZig: optionalPrice(/^[0-9]{1,9}(\.[0-9]{1,2})?$/, messages.priceZig),
    // Only that one was chosen. Whether it's this restaurant's is addMenuItem's
    // question, so another restaurant's id gets the 404 an unknown one does.
    categoryId: z.string(messages.category).min(1, messages.category),
  })
  // The database refuses an item with neither, too: this gives the reason.
  .refine((item) => item.priceUsd !== null || item.priceZig !== null, {
    message: messages.price,
    path: ["priceUsd"],
  });

export type NewCategory = z.output<typeof newCategory>;
export type NewMenuItem = z.output<typeof newMenuItem>;

const parsed = <T>(result: z.ZodSafeParseResult<T>) =>
  result.success
    ? ({ success: true, data: result.data } as const)
    : ({ success: false, message: result.error.issues[0].message } as const);

export const parseNewCategory = (form: FormData) =>
  parsed(newCategory.safeParse(Object.fromEntries(form)));

export const parseNewMenuItem = (form: FormData) =>
  parsed(newMenuItem.safeParse(Object.fromEntries(form)));

export type Menu = Awaited<ReturnType<typeof getMenu>>;

/** A restaurant's whole menu, with empty categories, for the editor and the page. */
export function getMenu(ctx: Tenant) {
  const { restaurantId } = ctx;
  return withTenant(ctx, async (tx) => {
    const [restaurant] = await tx
      .select({
        name: restaurants.name,
        menuToken: restaurants.menuToken,
        currencyMode: restaurants.currencyMode,
        zigStep: restaurants.zigRoundingStep,
        usdStep: restaurants.usdRoundingStep,
      })
      .from(restaurants)
      .where(eq(restaurants.id, restaurantId));
    const groups = await tx
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .where(eq(categories.restaurantId, restaurantId))
      .orderBy(asc(categories.sortOrder), asc(categories.name));
    const items = await tx
      .select({
        id: menuItems.id,
        categoryId: menuItems.categoryId,
        name: menuItems.name,
        description: menuItems.description,
        priceUsd: menuItems.priceUsd,
        priceZig: menuItems.priceZig,
      })
      .from(menuItems)
      .where(eq(menuItems.restaurantId, restaurantId))
      .orderBy(asc(menuItems.sortOrder), asc(menuItems.name));

    const rate = await latestRate(tx, restaurantId);

    const itemsByCategory = Map.groupBy(items, (item) => item.categoryId);
    return {
      restaurantName: restaurant.name,
      menuToken: restaurant.menuToken,
      currencyMode: restaurant.currencyMode,
      // Everything an effective price is computed from (spec 00): see "@/lib/pricing".
      pricing: {
        rate: rate?.usdToZig ?? null,
        zigStep: restaurant.zigStep,
        usdStep: restaurant.usdStep,
      },
      rateSetAt: rate?.setAt ?? null,
      categories: groups.map((group) => ({
        ...group,
        items: itemsByCategory.get(group.id) ?? [],
      })),
    };
  });
}

export async function addCategory(ctx: Writer, category: NewCategory) {
  const { restaurantId } = ctx;
  await withTenant(ctx, async (tx) => {
    const [added] = await tx
      .insert(categories)
      .values({
        restaurantId,
        name: category.name,
        sortOrder: sql`(
          select coalesce(max(${categories.sortOrder}), -1) + 1 from ${categories}
          where ${eq(categories.restaurantId, restaurantId)}
        )`,
      })
      .returning({ id: categories.id });
    await recordAdminAction(tx, ctx, {
      action: "category.create",
      entityType: "category",
      entityId: added.id,
    });
  });
  revalidateMenu(ctx);
}

/**
 * Adds an item at the end of its category. The composite foreign key is what
 * refuses a category of another restaurant, which RLS wouldn't: it checks only
 * the row being written.
 */
export async function addMenuItem(
  ctx: Writer,
  { categoryId, ...item }: NewMenuItem,
): Promise<"saved" | "no_such_category"> {
  if (!z.uuid().safeParse(categoryId).success) return "no_such_category";

  const { restaurantId } = ctx;
  try {
    await withTenant(ctx, async (tx) => {
      const [added] = await tx
        .insert(menuItems)
        .values({
          ...item,
          restaurantId,
          categoryId,
          sortOrder: sql`(
            select coalesce(max(${menuItems.sortOrder}), -1) + 1 from ${menuItems}
            where ${and(
              eq(menuItems.restaurantId, restaurantId),
              eq(menuItems.categoryId, categoryId),
            )}
          )`,
        })
        .returning({ id: menuItems.id });
      await recordAdminAction(tx, ctx, {
        action: "menu_item.create",
        entityType: "menu_item",
        entityId: added.id,
      });
    });
  } catch (error) {
    const { code } = (error as { cause?: { code?: string } }).cause ?? {};
    if (code === FOREIGN_KEY_VIOLATION) return "no_such_category";
    throw error;
  }
  revalidateMenu(ctx);
  return "saved";
}
