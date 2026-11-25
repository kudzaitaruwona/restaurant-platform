import type { NextRequest } from "next/server";
import { confirmationNeeded } from "@/lib/confirm-response";
import { formSaved } from "@/lib/form-response";
import { addCategory, categoryWarnings, parseNewCategory } from "@/lib/menu";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/** Adds a category, from /dashboard/menu. Owner only (S-26). */
export async function POST(request: NextRequest) {
  const tenant = await getTenantContext();
  requireOwner(tenant);

  const form = await request.formData().catch(() => new FormData());
  const category = parseNewCategory(form);
  if (!category.success) {
    return Response.json({ error: category.message }, { status: 400 });
  }
  const ask = await confirmationNeeded(request, form, "/dashboard/menu", () =>
    categoryWarnings(tenant, category.data.name),
  );
  if (ask) return ask;

  await addCategory(tenant, category.data);
  return formSaved(request, "/dashboard/menu");
}
