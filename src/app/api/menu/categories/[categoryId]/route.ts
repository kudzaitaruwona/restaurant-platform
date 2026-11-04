import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { formSaved } from "@/lib/form-response";
import { parseNewCategory, renameCategory } from "@/lib/menu";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/** Renames a category, from /dashboard/menu. Owner only (S-26). */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/menu/categories/[categoryId]">,
) {
  const tenant = await getTenantContext();
  requireOwner(tenant);
  const { categoryId } = await context.params;

  const category = parseNewCategory(
    await request.formData().catch(() => new FormData()),
  );
  if (!category.success) {
    return Response.json({ error: category.message }, { status: 400 });
  }

  if ((await renameCategory(tenant, categoryId, category.data)) === "not_found") {
    notFound();
  }
  return formSaved(request, "/dashboard/menu");
}
