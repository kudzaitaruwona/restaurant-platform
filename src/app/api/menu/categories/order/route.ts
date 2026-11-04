import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { formSaved } from "@/lib/form-response";
import { parseCategoryOrder, reorderCategories } from "@/lib/menu";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/**
 * Saves the order of the categories after a drag, from /dashboard/menu. Owner
 * only (S-26). The ids are the form's `ids`, repeated, first to last.
 */
export async function POST(request: NextRequest) {
  const tenant = await getTenantContext();
  requireOwner(tenant);

  const order = parseCategoryOrder(
    await request.formData().catch(() => new FormData()),
  );
  if (!order.success) {
    return Response.json({ error: order.message }, { status: 400 });
  }

  if ((await reorderCategories(tenant, order.data)) === "not_found") notFound();
  return formSaved(request, "/dashboard/menu");
}
