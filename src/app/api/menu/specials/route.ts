import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { formSaved } from "@/lib/form-response";
import { createSpecial, overlapMessage, parseNewSpecial } from "@/lib/specials";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/**
 * Adds a promotion, from /dashboard/menu. Owner only (S-26). The item is in the
 * form rather than the URL, because the form chooses it; the restaurant is the
 * session's and nothing in the request can change that.
 */
export async function POST(request: NextRequest) {
  const tenant = await getTenantContext();
  requireOwner(tenant);

  const special = parseNewSpecial(
    await request.formData().catch(() => new FormData()),
  );
  if (!special.success) {
    return Response.json({ error: special.message }, { status: 400 });
  }

  const result = await createSpecial(tenant, special.data);
  if (result === "no_such_item") notFound();
  if (result === "overlap") {
    return Response.json({ error: overlapMessage }, { status: 409 });
  }
  return formSaved(request, "/dashboard/menu");
}
