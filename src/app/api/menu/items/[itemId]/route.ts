import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { confirmationNeeded } from "@/lib/confirmation";
import { formSaved } from "@/lib/form-response";
import { bundleDescriptionMessage, itemWarnings, parseItemEdit, updateMenuItem } from "@/lib/menu";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/** Edits an item, from /dashboard/menu. Owner only (S-26). */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/menu/items/[itemId]">,
) {
  const tenant = await getTenantContext();
  requireOwner(tenant);
  const { itemId } = await context.params;

  const form = await request.formData().catch(() => new FormData());
  const item = parseItemEdit(form);
  if (!item.success) {
    return Response.json({ error: item.message }, { status: 400 });
  }
  const ask = confirmationNeeded(await itemWarnings(tenant, item.data, itemId), form);
  if (ask) return ask;

  const result = await updateMenuItem(tenant, itemId, item.data);
  if (result === "not_found" || result === "no_such_category") notFound();
  if (result === "no_description") {
    return Response.json({ error: bundleDescriptionMessage }, { status: 400 });
  }
  if (result === "no_price") {
    return Response.json(
      { error: "Enter a USD price, or give the item a ZiG price." },
      { status: 400 },
    );
  }
  return formSaved(request, "/dashboard/menu");
}
