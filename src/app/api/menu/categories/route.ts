import type { NextRequest } from "next/server";
import { formSaved } from "@/lib/form-response";
import { addCategory, parseNewCategory } from "@/lib/menu";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/** Adds a category, from /dashboard/menu. Owner only (S-26). */
export async function POST(request: NextRequest) {
  const tenant = await getTenantContext();
  requireOwner(tenant);

  const category = parseNewCategory(
    await request.formData().catch(() => new FormData()),
  );
  if (!category.success) {
    return Response.json({ error: category.message }, { status: 400 });
  }

  await addCategory(tenant, category.data);
  return formSaved(request, "/dashboard/menu");
}
