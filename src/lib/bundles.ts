import "server-only";
import { z } from "zod";
import { FOREIGN_KEY_VIOLATION, hasAPrice, hasLiveCategory, insertMenuItem, itemFields, noPrice } from "@/lib/menu";
import { revalidateMenu } from "@/lib/menu-cache";
import {
  errorCode,
  insertSpecial,
  optionalDate,
  optionalText,
  specialMessages,
  specialRefusal,
} from "@/lib/specials";
import { type TenantContext, withTenant } from "@/lib/tenant/scope";

/**
 * Bundles (spec 02 › Specials): a new item with `visibility = special_only`,
 * made together with its special, in one transaction. Owner only (S-26): callers
 * check requireOwner(ctx). The customer's page shows it only while the special is
 * live, which is "@/lib/menu"'s question. Every write calls revalidateMenu.
 */

type Writer = Pick<TenantContext, "restaurantId" | "platformAdminId">;

const messages = {
  description: "List what's included, in up to 1000 characters.",
};

/** The special's badge when the owner gives none: a special must have one. */
export const DEFAULT_BUNDLE_BADGE = "Bundle";

const newBundle = itemFields
  .extend({
    // What's included: spec 02 says the description lists it, so it can't be blank.
    description: z
      .string(messages.description)
      .trim()
      .min(1, messages.description)
      .max(1000, messages.description),
    title: optionalText(specialMessages.title, 80),
    startDate: optionalDate,
    endDate: optionalDate,
  })
  .refine(hasAPrice, noPrice)
  .refine(
    // ISO dates sort as text.
    ({ startDate, endDate }) => startDate === null || endDate === null || endDate >= startDate,
    { message: specialMessages.order, path: ["endDate"] },
  );

export type NewBundle = z.output<typeof newBundle>;

export const parseNewBundle = (form: FormData) => {
  const result = newBundle.safeParse(Object.fromEntries(form));
  return result.success
    ? ({ success: true, data: result.data } as const)
    : ({ success: false, message: result.error.issues[0].message } as const);
};

/**
 * Adds the bundle and its special, or neither: the special is refused for
 * "overlap" (D-05, which a brand-new item can't meet, but the answer is the same
 * as createSpecial's) or "already_over" (a blank start with an end date in the
 * past), and then the item is rolled back with it. A category that is archived or
 * another restaurant's is "no_such_category".
 */
export async function createBundle(
  ctx: Writer,
  { categoryId, title, startDate, endDate, ...fields }: NewBundle,
): Promise<"saved" | "no_such_category" | "overlap" | "already_over"> {
  if (!z.uuid().safeParse(categoryId).success) return "no_such_category";

  const { restaurantId } = ctx;
  try {
    const added = await withTenant(ctx, async (tx) => {
      if (!(await hasLiveCategory(tx, restaurantId, categoryId))) return false;
      const item = await insertMenuItem(tx, ctx, {
        ...fields,
        categoryId,
        visibility: "special_only",
      });
      await insertSpecial(tx, ctx, {
        menuItemId: item.id,
        title: title ?? DEFAULT_BUNDLE_BADGE,
        priceUsd: null,
        priceZig: null,
        startDate,
        endDate,
      });
      return true;
    });
    if (!added) return "no_such_category";
  } catch (error) {
    const refusal = specialRefusal(error);
    if (refusal) return refusal;
    if (errorCode(error) === FOREIGN_KEY_VIOLATION) return "no_such_category";
    throw error;
  }
  revalidateMenu(ctx);
  return "saved";
}
