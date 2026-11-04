import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { formSaved } from "@/lib/form-response";
import { removeItemPhoto } from "@/lib/menu-photos";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/** Removes an item's photo, from /dashboard/menu. Owner only (S-26). */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/menu/items/[itemId]/photo/remove">,
) {
  const tenant = await getTenantContext();
  requireOwner(tenant);
  const { itemId } = await context.params;

  if ((await removeItemPhoto(tenant, itemId)) === "no_such_item") notFound();
  return formSaved(request, "/dashboard/menu");
}
