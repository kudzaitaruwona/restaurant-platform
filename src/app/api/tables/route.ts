import type { NextRequest } from "next/server";
import { formSaved } from "@/lib/form-response";
import { addTable, labelTakenMessage, parseNewTable } from "@/lib/tables";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/** Adds a table, from /dashboard/tables. Owner only (S-26). */
export async function POST(request: NextRequest) {
  const tenant = await getTenantContext();
  requireOwner(tenant);

  const table = parseNewTable(
    await request.formData().catch(() => new FormData()),
  );
  if (!table.success) {
    return Response.json({ error: table.message }, { status: 400 });
  }

  if ((await addTable(tenant, table.data)) === "label_taken") {
    return Response.json({ error: labelTakenMessage }, { status: 409 });
  }
  return formSaved(request, "/dashboard/tables");
}
