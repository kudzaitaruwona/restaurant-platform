import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { confirmationNeeded } from "@/lib/confirmation";
import { formSaved } from "@/lib/form-response";
import { categoryWarnings, parseNewCategory, renameCategory } from "@/lib/menu";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/** Renames a category, from /dashboard/menu. Owner only (S-26). */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/menu/categories/[categoryId]">,
) {
  const tenant = await getTenantContext();
  requireOwner(tenant);
  const { categoryId } = await context.params;

  const form = await request.formData().catch(() => new FormData());
  const category = parseNewCategory(form);
  if (!category.success) {
    return Response.json({ error: category.message }, { status: 400 });
  }
  const ask = confirmationNeeded(
    await categoryWarnings(tenant, category.data.name, categoryId),
    form,
  );
  if (ask) return ask;

  if ((await renameCategory(tenant, categoryId, category.data)) === "not_found") {
    notFound();
  }
  return formSaved(request, "/dashboard/menu");
}
