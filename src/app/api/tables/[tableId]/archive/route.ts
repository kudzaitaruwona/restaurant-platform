import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { formSaved } from "@/lib/form-response";
import { archiveTable, tableIdFrom } from "@/lib/tables";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/**
 * Archives a table, from /dashboard/tables. Owner only (S-26). A table with
 * future bookings answers 409 with those bookings listed (name, time, party:
 * never a phone) so staff can move or cancel them first.
 */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/tables/[tableId]/archive">,
) {
  const tenant = await getTenantContext();
  requireOwner(tenant);
  const tableId = await tableIdFrom(context.params);

  const outcome = await archiveTable(tenant, tableId);
  if (outcome === "not_found") notFound();
  if (typeof outcome === "object") {
    return Response.json(
      { error: outcome.blocked.message, bookings: outcome.blocked.bookings },
      { status: 409 },
    );
  }
  return formSaved(request, "/dashboard/tables");
}
