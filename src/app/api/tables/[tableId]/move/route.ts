import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { formSaved } from "@/lib/form-response";
import { moveTable, parseDirection, tableIdFrom } from "@/lib/tables";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/** Moves a table up or down the list, from /dashboard/tables. Owner only (S-26). */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/tables/[tableId]/move">,
) {
  const tenant = await getTenantContext();
  requireOwner(tenant);
  const tableId = await tableIdFrom(context.params);

  const direction = parseDirection(await request.formData().catch(() => new FormData()));
  if (!direction.success) {
    return Response.json({ error: "Choose up or down." }, { status: 400 });
  }

  if ((await moveTable(tenant, tableId, direction.data)) === "not_found") notFound();
  return formSaved(request, "/dashboard/tables");
}
