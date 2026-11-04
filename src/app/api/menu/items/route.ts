import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { formSaved } from "@/lib/form-response";
import { addMenuItem, parseNewMenuItem } from "@/lib/menu";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/** Adds an item, from /dashboard/menu. Owner only (S-26). */
export async function POST(request: NextRequest) {
  const tenant = await getTenantContext();
  requireOwner(tenant);

  const item = parseNewMenuItem(
    await request.formData().catch(() => new FormData()),
  );
  if (!item.success) {
    return Response.json({ error: item.message }, { status: 400 });
  }

  if ((await addMenuItem(tenant, item.data)) === "no_such_category") notFound();
  return formSaved(request, "/dashboard/menu");
}
