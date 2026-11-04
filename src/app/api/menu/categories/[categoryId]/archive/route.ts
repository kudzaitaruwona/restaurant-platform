import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { formSaved } from "@/lib/form-response";
import { archiveCategory } from "@/lib/menu";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/**
 * Archives a category, from /dashboard/menu. Owner only (S-26). A category that
 * still has items needs `moveItemsTo`, or it's a 409 that says so.
 */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/menu/categories/[categoryId]/archive">,
) {
  const tenant = await getTenantContext();
  requireOwner(tenant);
  const { categoryId } = await context.params;

  const form = await request.formData().catch(() => new FormData());
  const moveItemsTo = form.get("moveItemsTo");
  const target = typeof moveItemsTo === "string" && moveItemsTo !== "" ? moveItemsTo : undefined;

  const result = await archiveCategory(tenant, categoryId, target);
  if (result === "not_found") notFound();
  if (result === "not_empty") {
    return Response.json(
      { error: "This category still has items. Choose where they should move." },
      { status: 409 },
    );
  }
  return formSaved(request, "/dashboard/menu");
}
