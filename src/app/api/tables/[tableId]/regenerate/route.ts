import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { formSaved } from "@/lib/form-response";
import { regenerateQrToken } from "@/lib/tables";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/** Gives a table a new QR token, from /dashboard/tables. Owner only (S-26). */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/tables/[tableId]/regenerate">,
) {
  const tenant = await getTenantContext();
  requireOwner(tenant);
  // A malformed id is a 404, like an unknown one.
  const tableId = z.uuid().safeParse((await context.params).tableId);
  if (!tableId.success) notFound();

  if ((await regenerateQrToken(tenant, tableId.data)) === "not_found") notFound();
  return formSaved(request, "/dashboard/tables");
}
