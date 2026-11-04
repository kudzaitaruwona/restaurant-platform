import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { createBundle, parseNewBundle } from "@/lib/bundles";
import { formSaved } from "@/lib/form-response";
import { alreadyOverMessage, overlapMessage } from "@/lib/specials";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/**
 * Adds a bundle and its special in one go, from /dashboard/menu. Owner only
 * (S-26), checked before the body is read. The category is in the form because
 * the form chooses it; the restaurant is the session's and nothing in the
 * request can change that.
 */
export async function POST(request: NextRequest) {
  const tenant = await getTenantContext();
  requireOwner(tenant);

  const bundle = parseNewBundle(await request.formData().catch(() => new FormData()));
  if (!bundle.success) {
    return Response.json({ error: bundle.message }, { status: 400 });
  }

  const result = await createBundle(tenant, bundle.data);
  if (result === "no_such_category") notFound();
  if (result === "overlap") {
    return Response.json({ error: overlapMessage }, { status: 409 });
  }
  if (result === "already_over") {
    return Response.json({ error: alreadyOverMessage }, { status: 400 });
  }
  return formSaved(request, "/dashboard/menu");
}
