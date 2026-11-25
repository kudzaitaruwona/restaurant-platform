import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { confirmationNeeded } from "@/lib/confirm-response";
import { formSaved } from "@/lib/form-response";
import { addMenuItem, itemWarnings, parseNewMenuItem } from "@/lib/menu";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/** Adds an item, from /dashboard/menu. Owner only (S-26). */
export async function POST(request: NextRequest) {
  const tenant = await getTenantContext();
  requireOwner(tenant);

  const form = await request.formData().catch(() => new FormData());
  const item = parseNewMenuItem(form);
  if (!item.success) {
    return Response.json({ error: item.message }, { status: 400 });
  }
  const ask = await confirmationNeeded(request, form, "/dashboard/menu", () =>
    itemWarnings(tenant, item.data),
  );
  if (ask) return ask;

  if ((await addMenuItem(tenant, item.data)) === "no_such_category") notFound();
  return formSaved(request, "/dashboard/menu");
}
