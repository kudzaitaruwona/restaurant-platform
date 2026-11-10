import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { dismissWaiter } from "@/lib/floor";
import { formSaved } from "@/lib/form-response";
import { getTenantContext } from "@/lib/tenant";
import { z } from "zod";

/**
 * Dismiss a table's "Call a waiter" (spec 06, proposed), from the floor grid or a
 * table's detail. Owners and staff both (S-26). The restaurant comes from the
 * session, the table from the URL, and a table of another restaurant is a 404.
 * Dismissing a call that is already gone is a success: two waiters tapping at
 * once both did what they meant.
 */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/floor/[tableId]/dismiss-waiter">,
) {
  const tenant = await getTenantContext();
  const tableId = z.uuid().safeParse((await context.params).tableId);
  if (!tableId.success) notFound();

  const result = await dismissWaiter(tenant, tableId.data);
  if (result.outcome === "not_found") notFound();
  return formSaved(request, "/dashboard/floor");
}
