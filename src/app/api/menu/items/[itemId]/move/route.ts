import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { formSaved } from "@/lib/form-response";
import { moveMenuItem } from "@/lib/menu";
import { parseDirection } from "@/lib/tables";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/** Moves an item up or down its category, from /dashboard/menu. Owner only (S-26). */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/menu/items/[itemId]/move">,
) {
  const tenant = await getTenantContext();
  requireOwner(tenant);
  const { itemId } = await context.params;

  const direction = parseDirection(await request.formData().catch(() => new FormData()));
  if (!direction.success) {
    return Response.json({ error: "Choose up or down." }, { status: 400 });
  }

  if ((await moveMenuItem(tenant, itemId, direction.data)) === "not_found") notFound();
  return formSaved(request, "/dashboard/menu");
}
