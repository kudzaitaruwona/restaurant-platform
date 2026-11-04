import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { formSaved } from "@/lib/form-response";
import { labelTakenMessage, parseTableEdit, tableIdFrom, updateTable } from "@/lib/tables";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/** Edits a table's label, capacity and bookable flag, from /dashboard/tables. Owner only (S-26). */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/tables/[tableId]">,
) {
  const tenant = await getTenantContext();
  requireOwner(tenant);
  const tableId = await tableIdFrom(context.params);

  const edit = parseTableEdit(await request.formData().catch(() => new FormData()));
  if (!edit.success) {
    return Response.json({ error: edit.message }, { status: 400 });
  }

  const outcome = await updateTable(tenant, tableId, edit.data);
  if (outcome === "not_found") notFound();
  if (outcome === "label_taken") {
    return Response.json({ error: labelTakenMessage }, { status: 409 });
  }
  return formSaved(request, "/dashboard/tables");
}
