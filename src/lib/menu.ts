import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { categories, menuItems, restaurants } from "@/db/schema";
import { revalidateMenu } from "@/lib/menu-cache";
import { type TenantContext, withTenant } from "@/lib/tenant/scope";

/**
 * The menu (spec 02). Writes are owner only (S-26): callers check
 * requireOwner(ctx). A public route reads this too, so it imports the tenant
 * scope rather than "@/lib/tenant", which would load sign-in (S-32).
 *
 * Every write here calls revalidateMenu, so a route can't forget to. Not audited:
 * spec 01's list doesn't include menu edits.
 */

type Tenant = Pick<TenantContext, "restaurantId">;

const FOREIGN_KEY_VIOLATION = "23503";

const messages = {
  categoryName: "Enter the category's name, up to 200 characters.",
  itemName: "Enter the item's name, up to 200 characters.",
  description: "Enter a description of up to 1000 characters.",
  priceUsd: "Enter the USD price as a number, like 8.50.",
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

const newMenuItem = z.object({
  name: z
    .string(messages.itemName)
    .trim()
    .min(1, messages.itemName)
    .max(200, messages.itemName),
  description: z
    .string(messages.description)
    .trim()
    .max(1000, messages.description),
  // Postgres would also take 1e3, NaN and Infinity as numeric.
  priceUsd: z
    .string(messages.priceUsd)
    .trim()
    .regex(/^[0-9]{1,6}(\.[0-9]{1,2})?$/, messages.priceUsd),
  // Only that one was chosen. Whether it's this restaurant's is addMenuItem's
  // question, so another restaurant's id gets the 404 an unknown one does.
  categoryId: z.string(messages.category).min(1, messages.category),
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

/** Issue 20 replaces this with display by `currency_mode`. */
export const formatUsd = (price: string) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number(price));

export type Menu = Awaited<ReturnType<typeof getMenu>>;

/** A restaurant's whole menu, with empty categories, for the editor and the page. */
export function getMenu(ctx: Tenant) {
  const { restaurantId } = ctx;
  return withTenant(ctx, async (tx) => {
    const [restaurant] = await tx
      .select({ name: restaurants.name, menuToken: restaurants.menuToken })
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

    const itemsByCategory = Map.groupBy(items, (item) => item.categoryId);
    return {
      restaurantName: restaurant.name,
      menuToken: restaurant.menuToken,
      categories: groups.map((group) => ({
        ...group,
        items: itemsByCategory.get(group.id) ?? [],
      })),
    };
  });
}

export async function addCategory(ctx: Tenant, category: NewCategory) {
  const { restaurantId } = ctx;
  await withTenant(ctx, (tx) =>
    tx.insert(categories).values({
      restaurantId,
      name: category.name,
      sortOrder: sql`(
        select coalesce(max(${categories.sortOrder}), -1) + 1 from ${categories}
        where ${eq(categories.restaurantId, restaurantId)}
      )`,
    }),
  );
  revalidateMenu(ctx);
}

/**
 * Adds an item at the end of its category. The composite foreign key is what
 * refuses a category of another restaurant, which RLS wouldn't: it checks only
 * the row being written.
 */
export async function addMenuItem(
  ctx: Tenant,
  { categoryId, ...item }: NewMenuItem,
): Promise<"saved" | "no_such_category"> {
  if (!z.uuid().safeParse(categoryId).success) return "no_such_category";

  const { restaurantId } = ctx;
  try {
    await withTenant(ctx, (tx) =>
      tx.insert(menuItems).values({
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
      }),
    );
  } catch (error) {
    const { code } = (error as { cause?: { code?: string } }).cause ?? {};
    if (code === FOREIGN_KEY_VIOLATION) return "no_such_category";
    throw error;
  }
  revalidateMenu(ctx);
  return "saved";
}
