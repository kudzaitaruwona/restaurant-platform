import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { menuItems } from "@/db/schema";
import { revalidateMenu } from "@/lib/menu-cache";
import { photoKeys } from "@/lib/photo-urls";
import { resizePhoto } from "@/lib/photo-image";
import { deleteImage, uploadImage } from "@/lib/storage";
import { recordAdminAction } from "@/lib/tenant/audit";
import { type TenantContext, withTenant } from "@/lib/tenant/scope";

/**
 * Item photos (spec 02 › Photos). Owner only, like the rest of the menu: callers
 * check requireOwner(ctx). Files go through the storage interface and nothing
 * else (D-07).
 *
 * Every upload gets a new random key, with no id of ours in it because the
 * public page prints it, so the CDN and the customer's browser can't serve
 * the old photo after a replace, and so a failed save never overwrites the
 * photo that is showing. Order matters for the same reason: new files first, then
 * the row, then the old files. A crash between leaves stray files, never a page
 * pointing at nothing.
 */

type Writer = Pick<TenantContext, "restaurantId" | "platformAdminId">;
type Outcome = "saved" | "no_such_item";

/**
 * The item's current photo key, or undefined when this restaurant has no such
 * live item. An archived item keeps its photo, and it can't be changed, as the
 * item can't be edited.
 */
async function findItem(ctx: Writer, itemId: string) {
  if (!z.uuid().safeParse(itemId).success) return undefined;
  return withTenant(ctx, async (tx) => {
    const [item] = await tx
      .select({ photoKey: menuItems.photoKey })
      .from(menuItems)
      .where(
        and(
          eq(menuItems.restaurantId, ctx.restaurantId),
          eq(menuItems.id, itemId),
          isNull(menuItems.archivedAt),
        ),
      );
    return item;
  });
}

async function deleteFiles(photoKey: string | null) {
  if (!photoKey) return;
  const { large, thumb } = photoKeys(photoKey);
  // Past the point of no return: the row no longer names these. A failure leaves
  // two stray files, which costs a little storage, so it mustn't fail the save.
  await Promise.all(
    [large, thumb].map((key) =>
      deleteImage(key).catch((error) =>
        console.error(`Couldn't delete stored photo ${key}`, error),
      ),
    ),
  );
}

async function savePhotoKey(
  ctx: Writer,
  itemId: string,
  photoKey: string | null,
  action: string,
) {
  await withTenant(ctx, async (tx) => {
    await tx
      .update(menuItems)
      .set({ photoKey })
      .where(
        and(eq(menuItems.restaurantId, ctx.restaurantId), eq(menuItems.id, itemId)),
      );
    await recordAdminAction(tx, ctx, {
      action,
      entityType: "menu_item",
      entityId: itemId,
    });
  });
}

/** Throws PhotoRefused for something that isn't a usable image. */
export async function setItemPhoto(
  ctx: Writer,
  itemId: string,
  bytes: Uint8Array,
): Promise<Outcome> {
  const item = await findItem(ctx, itemId);
  if (!item) return "no_such_item";

  const { large, thumb } = await resizePhoto(bytes);
  const photoKey = `menu/${crypto.randomUUID()}`;
  const keys = photoKeys(photoKey);
  try {
    // Settled, not Promise.all: the cleanup below mustn't race a PUT still in flight.
    const uploads = await Promise.allSettled([
      uploadImage(keys.large, large, "image/webp"),
      uploadImage(keys.thumb, thumb, "image/webp"),
    ]);
    for (const upload of uploads) {
      if (upload.status === "rejected") throw upload.reason;
    }
    await savePhotoKey(ctx, itemId, photoKey, "menu_item.photo_set");
  } catch (error) {
    await deleteFiles(photoKey);
    throw error;
  }
  await deleteFiles(item.photoKey);
  revalidateMenu(ctx);
  return "saved";
}

export async function removeItemPhoto(ctx: Writer, itemId: string): Promise<Outcome> {
  const item = await findItem(ctx, itemId);
  if (!item) return "no_such_item";
  if (!item.photoKey) return "saved";

  await savePhotoKey(ctx, itemId, null, "menu_item.photo_remove");
  await deleteFiles(item.photoKey);
  revalidateMenu(ctx);
  return "saved";
}
