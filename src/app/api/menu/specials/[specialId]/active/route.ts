import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { formSaved } from "@/lib/form-response";
import { overlapMessage, parseSpecialActive, setSpecialActive } from "@/lib/specials";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/** Turns a promotion on or off, from /dashboard/menu. Owner only (S-26). */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/menu/specials/[specialId]/active">,
) {
  const tenant = await getTenantContext();
  requireOwner(tenant);
  const { specialId } = await context.params;

  const active = parseSpecialActive(
    await request.formData().catch(() => new FormData()),
  );
  if (!active.success) {
    return Response.json({ error: active.message }, { status: 400 });
  }

  const result = await setSpecialActive(tenant, specialId, active.data);
  if (result === "not_found") notFound();
  if (result === "overlap") {
    return Response.json({ error: overlapMessage }, { status: 409 });
  }
  return formSaved(request, "/dashboard/menu");
}
