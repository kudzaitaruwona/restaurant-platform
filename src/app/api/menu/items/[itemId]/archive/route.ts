import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { formSaved } from "@/lib/form-response";
import { archiveMenuItem } from "@/lib/menu";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/** Archives an item instead of deleting it. Owner only (S-26). */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/menu/items/[itemId]/archive">,
) {
  const tenant = await getTenantContext();
  requireOwner(tenant);
  const { itemId } = await context.params;

  if ((await archiveMenuItem(tenant, itemId)) === "not_found") notFound();
  return formSaved(request, "/dashboard/menu");
}
