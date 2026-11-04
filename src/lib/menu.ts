import "server-only";
import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { categories, menuItems, restaurants, specials } from "@/db/schema";
import { latestRate } from "@/lib/exchange-rate";
import { revalidateMenu } from "@/lib/menu-cache";
import { recordAdminAction } from "@/lib/tenant/audit";
import {
  type TenantContext,
  type TenantTransaction,
  withTenant,
} from "@/lib/tenant/scope";

/**
 * The menu (spec 02). Writes are owner only (S-26): callers check
 * requireOwner(ctx), except setItemAvailability, which owners and staff both
 * make. A public route reads this too, so it imports the tenant scope rather
 * than "@/lib/tenant", which would load sign-in (S-32).
 *
 * Every write here calls revalidateMenu, so a route can't forget to. Spec 01's
 * audit list doesn't include menu edits, so only a platform admin's are audited.
 */

type Tenant = Pick<TenantContext, "restaurantId">;
type Writer = Tenant & Pick<TenantContext, "platformAdminId">;

export const FOREIGN_KEY_VIOLATION = "23503";
const CHECK_VIOLATION = "23514";

const errorCode = (error: unknown) =>
  (error as { cause?: { code?: string } }).cause?.code;

const messages = {
  categoryName: "Enter the category's name, up to 200 characters.",
  itemName: "Enter the item's name, up to 200 characters.",
  description: "Enter a description of up to 1000 characters.",
  priceUsd: "Enter the USD price as a number, like 8.50.",
  priceZig: "Enter the ZiG price as a number, like 210.",
  price: "Enter a USD price, a ZiG price, or both.",
  category: "Choose a category.",
  sortOrder: "Enter the sort order as a whole number from 0 to 9999.",
  order: "Send each category once, in the order they should appear.",
};

// Messages are fixed strings, so a refused value is never echoed back.
const newCategory = z.object({
  name: z
    .string(messages.categoryName)
    .trim()
    .min(1, messages.categoryName)
    .max(200, messages.categoryName),
});

const newAvailability = z.object({
  available: z.enum(["true", "false"], "Choose available or sold out."),
});

// A price field left blank is no price. Postgres would also take 1e3, NaN and
// Infinity as numeric, so the spelling is checked here.
export const optionalPrice = (pattern: RegExp, message: string) =>
  z.preprocess(
    (value) => (value === undefined ? "" : value),
    z
      .string(message)
      .trim()
      .refine((value) => value === "" || pattern.test(value), message)
      .transform((value) => value || null),
  );

export const itemFields = z.object({
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
});

// The database refuses an item with neither, too: this gives the reason.
export const hasAPrice = (item: { priceUsd: string | null; priceZig: string | null }) =>
  item.priceUsd !== null || item.priceZig !== null;
export const noPrice = { message: messages.price, path: ["priceUsd"] };

const newMenuItem = itemFields.refine(hasAPrice, noPrice);

const itemEdit = itemFields
  .extend({
    sortOrder: z
      .string(messages.sortOrder)
      .trim()
      .regex(/^[0-9]{1,4}$/, messages.sortOrder)
      .transform(Number),
  })
  .refine(hasAPrice, noPrice);

// Whether each is a category of this restaurant is reorderCategories' question,
// so a malformed id gets the 404 an unknown one does.
const categoryOrder = z
  .array(z.string(messages.order).min(1, messages.order))
  .min(1, messages.order)
  .max(500, messages.order)
  .refine((ids) => new Set(ids).size === ids.length, messages.order);

export type NewCategory = z.output<typeof newCategory>;
export type ItemEdit = z.output<typeof itemEdit>;
export type NewMenuItem = z.output<typeof newMenuItem>;

const parsed = <T>(result: z.ZodSafeParseResult<T>) =>
  result.success
    ? ({ success: true, data: result.data } as const)
    : ({ success: false, message: result.error.issues[0].message } as const);

export const parseNewCategory = (form: FormData) =>
  parsed(newCategory.safeParse(Object.fromEntries(form)));

export const parseNewMenuItem = (form: FormData) =>
  parsed(newMenuItem.safeParse(Object.fromEntries(form)));

export const parseAvailability = (form: FormData) => {
  const result = newAvailability.safeParse(Object.fromEntries(form));
  return result.success
    ? ({ success: true, data: result.data.available === "true" } as const)
    : ({ success: false, message: result.error.issues[0].message } as const);
};

export const parseItemEdit = (form: FormData) =>
  parsed(itemEdit.safeParse(Object.fromEntries(form)));

/** The categories in the order they should appear: the field is repeated. */
export const parseCategoryOrder = (form: FormData) =>
  parsed(categoryOrder.safeParse(form.getAll("ids")));

export type Menu = Awaited<ReturnType<typeof getMenu>>;

/**
 * A restaurant's whole menu, with empty categories, for the editor and the page.
 * Archived categories and items are in neither (spec 02).
 *
 * Bundles (`visibility = special_only`) are what `forEditor` is about. The
 * default is the customer's view and is safe to cache: a bundle is in no
 * category, and is in `bundles` only while one of its specials is live. The
 * editor passes `forEditor` and gets every bundle in its category, live or not,
 * so the owner can still see and manage one out of its window; `bundles` is then
 * empty. Callers that don't say get the customer's view.
 *
 * An item's `special` is
 * the one live at `now`, if any: the window is [starts_at, ends_at), a null start
 * has no lower end and a null end has no upper one. The page is cached, so `now`
 * is when it was rendered (see FRESH_FOR_SECONDS in public-menu.ts).
 */
export function getMenu(
  ctx: Tenant,
  now = new Date(),
  { forEditor = false }: { forEditor?: boolean } = {},
) {
  const { restaurantId } = ctx;
  return withTenant(ctx, async (tx) => {
    const [restaurant] = await tx
      .select({
        name: restaurants.name,
        menuToken: restaurants.menuToken,
        currencyMode: restaurants.currencyMode,
        timezone: restaurants.timezone,
        zigStep: restaurants.zigRoundingStep,
        usdStep: restaurants.usdRoundingStep,
      })
      .from(restaurants)
      .where(eq(restaurants.id, restaurantId));
    const groups = await tx
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .where(
        and(eq(categories.restaurantId, restaurantId), isNull(categories.archivedAt)),
      )
      .orderBy(asc(categories.sortOrder), asc(categories.name));
    const items = await tx
      .select({
        id: menuItems.id,
        categoryId: menuItems.categoryId,
        name: menuItems.name,
        description: menuItems.description,
        priceUsd: menuItems.priceUsd,
        priceZig: menuItems.priceZig,
        available: menuItems.available,
        visibility: menuItems.visibility,
        sortOrder: menuItems.sortOrder,
        photoKey: menuItems.photoKey,
      })
      .from(menuItems)
      .where(
        and(eq(menuItems.restaurantId, restaurantId), isNull(menuItems.archivedAt)),
      )
      .orderBy(asc(menuItems.sortOrder), asc(menuItems.name));

    const rate = await latestRate(tx, restaurantId);

    // D-05 means at most one of these per item. A special on an archived item
    // matches no item below, so it never shows.
    const live = await tx
      .select({
        menuItemId: specials.menuItemId,
        title: specials.title,
        priceUsd: specials.specialPriceUsd,
        priceZig: specials.specialPriceZig,
      })
      .from(specials)
      .where(
        and(
          eq(specials.restaurantId, restaurantId),
          eq(specials.active, true),
          or(isNull(specials.startsAt), lte(specials.startsAt, now)),
          or(isNull(specials.endsAt), gt(specials.endsAt, now)),
        ),
      );
    const specialOf = new Map(live.map(({ menuItemId, ...rest }) => [menuItemId, rest]));

    const withSpecial = items.map((item) => ({
      ...item,
      special: specialOf.get(item.id) ?? null,
    }));
    const inCategory = (item: (typeof withSpecial)[number]) =>
      forEditor || item.visibility === "regular";
    const itemsByCategory = Map.groupBy(withSpecial.filter(inCategory), (item) => item.categoryId);
    // A bundle with no live special is nowhere: not a category, not here.
    const liveBundles = Map.groupBy(
      forEditor
        ? []
        : withSpecial.filter((item) => item.visibility === "special_only" && item.special),
      (item) => item.categoryId,
    );
    return {
      restaurantName: restaurant.name,
      menuToken: restaurant.menuToken,
      currencyMode: restaurant.currencyMode,
      timezone: restaurant.timezone,
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
      // In the categories' order, as promotions are.
      bundles: groups.flatMap((group) => liveBundles.get(group.id) ?? []),
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
 * Whether the category is this restaurant's and not archived. Held with a share
 * lock, so archiving it (which takes the row for update) waits for an item being
 * put in it, and the other way round: no live item ends up in an archived one.
 */
export async function hasLiveCategory(
  tx: TenantTransaction,
  restaurantId: string,
  categoryId: string,
) {
  const [category] = await tx
    .select({ id: categories.id })
    .from(categories)
    .where(
      and(
        eq(categories.restaurantId, restaurantId),
        eq(categories.id, categoryId),
        isNull(categories.archivedAt),
      ),
    )
    .for("share");
  return category !== undefined;
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
    const added = await withTenant(ctx, async (tx) => {
      if (!(await hasLiveCategory(tx, restaurantId, categoryId))) return null;
      return insertMenuItem(tx, ctx, { ...item, categoryId });
    });
    if (!added) return "no_such_category";
  } catch (error) {
    if (errorCode(error) === FOREIGN_KEY_VIOLATION) return "no_such_category";
    throw error;
  }
  revalidateMenu(ctx);
  return "saved";
}

/**
 * Inserts an item at the end of its category and audits it. The caller has
 * checked the category is live, and revalidates after commit.
 */
export async function insertMenuItem(
  tx: TenantTransaction,
  ctx: Writer,
  { categoryId, ...fields }: Omit<typeof menuItems.$inferInsert, "restaurantId" | "sortOrder"> & {
    categoryId: string;
  },
) {
  const { restaurantId } = ctx;
  const [added] = await tx
    .insert(menuItems)
    .values({
      ...fields,
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
  return added;
}

/**
 * Marks an item sold out, or back on (spec 02, "we've run out tonight"). Owners
 * and staff both may (S-26), so this is the one item write that isn't owner
 * only. It changes nothing else about the item, and the composite key on the
 * tenant isn't needed here: the restaurant is in the where clause as well as
 * RLS, so another restaurant's item matches no row, and nor does an archived one.
 */
export async function setItemAvailability(
  ctx: Writer,
  itemId: string,
  available: boolean,
): Promise<"saved" | "no_such_item"> {
  if (!z.uuid().safeParse(itemId).success) return "no_such_item";

  const { restaurantId } = ctx;
  const saved = await withTenant(ctx, async (tx) => {
    const [updated] = await tx
      .update(menuItems)
      .set({ available })
      .where(liveItem(restaurantId, itemId))
      .returning({ id: menuItems.id });
    if (!updated) return false;

    await recordAdminAction(tx, ctx, {
      action: "menu_item.availability",
      entityType: "menu_item",
      entityId: updated.id,
      details: { available },
    });
    return true;
  });
  if (!saved) return "no_such_item";

  revalidateMenu(ctx);
  return "saved";
}

const isId = (id: string) => z.uuid().safeParse(id).success;

/** Renames a live category. An archived or foreign one is "not_found". */
export async function renameCategory(
  ctx: Writer,
  categoryId: string,
  { name }: NewCategory,
): Promise<"saved" | "not_found"> {
  if (!isId(categoryId)) return "not_found";

  const { restaurantId } = ctx;
  const renamed = await withTenant(ctx, async (tx) => {
    const [row] = await tx
      .update(categories)
      .set({ name })
      .where(liveCategory(restaurantId, categoryId))
      .returning({ id: categories.id });
    if (row) {
      await recordAdminAction(tx, ctx, {
        action: "category.rename",
        entityType: "category",
        entityId: row.id,
      });
    }
    return row;
  });
  if (!renamed) return "not_found";
  revalidateMenu(ctx);
  return "saved";
}

const liveCategory = (restaurantId: string, categoryId: string) =>
  and(
    eq(categories.restaurantId, restaurantId),
    eq(categories.id, categoryId),
    isNull(categories.archivedAt),
  );

/**
 * Puts the named categories in the order given. All of them must be this
 * restaurant's live categories, or nothing changes. A category the list leaves
 * out (one added meanwhile) keeps its place, and a tie falls back to its name.
 */
export async function reorderCategories(
  ctx: Writer,
  categoryIds: string[],
): Promise<"saved" | "not_found"> {
  if (!categoryIds.every(isId)) return "not_found";

  const { restaurantId } = ctx;
  const found = await withTenant(ctx, async (tx) => {
    const live = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(
        and(
          eq(categories.restaurantId, restaurantId),
          isNull(categories.archivedAt),
          inArray(categories.id, categoryIds),
        ),
      )
      .for("update");
    if (live.length !== categoryIds.length) return false;

    await tx
      .update(categories)
      .set({
        sortOrder: sql`array_position(${sql.param(categoryIds)}::uuid[], ${categories.id}) - 1`,
      })
      .where(
        and(eq(categories.restaurantId, restaurantId), inArray(categories.id, categoryIds)),
      );
    await recordAdminAction(tx, ctx, {
      action: "category.reorder",
      entityType: "category",
      entityId: categoryIds[0],
    });
    return true;
  });
  if (!found) return "not_found";
  revalidateMenu(ctx);
  return "saved";
}

/**
 * Archives a category (spec 02). If it still holds live items they must go
 * somewhere: `moveItemsTo` names a live category of the same restaurant, and
 * without one the answer is "not_empty" and nothing changes. Moved items go to
 * the end of the new category, in the order they had.
 */
export async function archiveCategory(
  ctx: Writer,
  categoryId: string,
  moveItemsTo?: string,
): Promise<"archived" | "not_found" | "not_empty"> {
  if (!isId(categoryId)) return "not_found";
  if (moveItemsTo !== undefined && (!isId(moveItemsTo) || moveItemsTo === categoryId)) {
    return "not_found";
  }

  const { restaurantId } = ctx;
  const result = await withTenant(ctx, async (tx) => {
    // For update: an item being added to it waits, and then finds it archived.
    const [category] = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(liveCategory(restaurantId, categoryId))
      .for("update");
    if (!category) return "not_found";

    const items = await tx
      .select({ id: menuItems.id })
      .from(menuItems)
      .where(
        and(
          eq(menuItems.restaurantId, restaurantId),
          eq(menuItems.categoryId, categoryId),
          isNull(menuItems.archivedAt),
        ),
      )
      .orderBy(asc(menuItems.sortOrder), asc(menuItems.name));

    if (items.length > 0) {
      if (moveItemsTo === undefined) return "not_empty";
      if (!(await hasLiveCategory(tx, restaurantId, moveItemsTo))) return "not_found";
      await tx
        .update(menuItems)
        .set({
          categoryId: moveItemsTo,
          // The old position, after what is already there.
          sortOrder: sql`${menuItems.sortOrder} + (
            select coalesce(max(m.sort_order), -1) + 1 from ${menuItems} m
            where m.restaurant_id = ${restaurantId} and m.category_id = ${moveItemsTo}
          )`,
        })
        .where(
          and(
            eq(menuItems.restaurantId, restaurantId),
            inArray(
              menuItems.id,
              items.map((item) => item.id),
            ),
          ),
        );
    }

    await tx
      .update(categories)
      .set({ archivedAt: sql`now()` })
      .where(liveCategory(restaurantId, categoryId));
    await recordAdminAction(tx, ctx, {
      action: "category.archive",
      entityType: "category",
      entityId: categoryId,
      details: { itemsMovedTo: items.length > 0 ? moveItemsTo : null },
    });
    return "archived";
  });
  if (result === "archived") revalidateMenu(ctx);
  return result;
}

const liveItem = (restaurantId: string, itemId: string) =>
  and(
    eq(menuItems.restaurantId, restaurantId),
    eq(menuItems.id, itemId),
    isNull(menuItems.archivedAt),
  );

/**
 * Saves the editor's fields on a live item. A blank ZiG price clears a fixed one,
 * so the item goes back to calculated from the rate (S-10).
 */
export async function updateMenuItem(
  ctx: Writer,
  itemId: string,
  { categoryId, ...fields }: ItemEdit,
): Promise<"saved" | "not_found" | "no_such_category" | "no_price"> {
  if (!isId(itemId)) return "not_found";
  if (!isId(categoryId)) return "no_such_category";

  const { restaurantId } = ctx;
  try {
    const result = await withTenant(ctx, async (tx) => {
      const [current] = await tx
        .select({ id: menuItems.id })
        .from(menuItems)
        .where(liveItem(restaurantId, itemId));
      if (!current) return "not_found";
      if (!(await hasLiveCategory(tx, restaurantId, categoryId))) {
        return "no_such_category";
      }
      await tx
        .update(menuItems)
        .set({ ...fields, categoryId })
        .where(liveItem(restaurantId, itemId));
      await recordAdminAction(tx, ctx, {
        action: "menu_item.update",
        entityType: "menu_item",
        entityId: itemId,
      });
      return "saved";
    });
    if (result === "saved") revalidateMenu(ctx);
    return result;
  } catch (error) {
    if (errorCode(error) === CHECK_VIOLATION) return "no_price";
    throw error;
  }
}

/**
 * Archives instead of deleting: nothing customer-facing is hard-deleted. That
 * includes the photo: its key and files stay, and only leave the public page with
 * the item.
 */
export async function archiveMenuItem(
  ctx: Writer,
  itemId: string,
): Promise<"archived" | "not_found"> {
  if (!isId(itemId)) return "not_found";

  const { restaurantId } = ctx;
  const archived = await withTenant(ctx, async (tx) => {
    const [row] = await tx
      .update(menuItems)
      .set({ archivedAt: sql`now()` })
      .where(liveItem(restaurantId, itemId))
      .returning({ id: menuItems.id });
    if (row) {
      await recordAdminAction(tx, ctx, {
        action: "menu_item.archive",
        entityType: "menu_item",
        entityId: row.id,
      });
    }
    return row;
  });
  if (!archived) return "not_found";
  revalidateMenu(ctx);
  return "archived";
}
