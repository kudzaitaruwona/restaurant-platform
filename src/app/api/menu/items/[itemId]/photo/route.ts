import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { formSaved } from "@/lib/form-response";
import { setItemPhoto } from "@/lib/menu-photos";
import { MAX_UPLOAD_BYTES, PhotoRefused } from "@/lib/photo-image";
import { getTenantContext, requireOwner } from "@/lib/tenant";

const refused = (error: string, status: number) =>
  Response.json({ error }, { status });

/**
 * Sets an item's photo, from /dashboard/menu. Owner only (S-26). The editor has
 * already shrunk the photo to fit Vercel's 4.5MB body limit, which would
 * otherwise refuse a phone's original before this runs.
 */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/menu/items/[itemId]/photo">,
) {
  const tenant = await getTenantContext();
  requireOwner(tenant);
  const { itemId } = await context.params;

  const form = await request.formData().catch(() => new FormData());
  const photo = form.get("photo");
  if (!(photo instanceof File) || photo.size === 0) {
    return refused("Choose a photo.", 400);
  }
  if (photo.size > MAX_UPLOAD_BYTES) {
    return refused("That photo is too large. Try a smaller one.", 413);
  }

  try {
    const bytes = new Uint8Array(await photo.arrayBuffer());
    if ((await setItemPhoto(tenant, itemId, bytes)) === "no_such_item") notFound();
  } catch (error) {
    if (error instanceof PhotoRefused) return refused(error.message, 400);
    throw error;
  }
  return formSaved(request, "/dashboard/menu");
}
