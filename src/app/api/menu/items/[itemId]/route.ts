import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { formSaved } from "@/lib/form-response";
import { parseItemEdit, updateMenuItem } from "@/lib/menu";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/** Edits an item, from /dashboard/menu. Owner only (S-26). */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/menu/items/[itemId]">,
) {
  const tenant = await getTenantContext();
  requireOwner(tenant);
  const { itemId } = await context.params;

  const item = parseItemEdit(await request.formData().catch(() => new FormData()));
  if (!item.success) {
    return Response.json({ error: item.message }, { status: 400 });
  }

  const result = await updateMenuItem(tenant, itemId, item.data);
  if (result === "not_found" || result === "no_such_category") notFound();
  if (result === "no_price") {
    return Response.json(
      { error: "Enter a USD price, or give the item a ZiG price." },
      { status: 400 },
    );
  }
  return formSaved(request, "/dashboard/menu");
}
