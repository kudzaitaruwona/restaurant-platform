import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { formSaved } from "@/lib/form-response";
import { archiveTable, tableIdFrom } from "@/lib/tables";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/**
 * Archives a table, from /dashboard/tables. Owner only (S-26). The check for
 * future bookings comes with bookings, in 4.11.
 */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/tables/[tableId]/archive">,
) {
  const tenant = await getTenantContext();
  requireOwner(tenant);
  const tableId = await tableIdFrom(context.params);

  if ((await archiveTable(tenant, tableId)) === "not_found") notFound();
  return formSaved(request, "/dashboard/tables");
}
