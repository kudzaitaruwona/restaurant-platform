import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { clearTable } from "@/lib/closing";
import { blockedBy, reloadToClose, sessionChanged, shownSessionFrom } from "@/lib/closing-responses";
import { formSaved } from "@/lib/form-response";
import { getTenantContext } from "@/lib/tenant";

/**
 * Clear table (spec 06, #74), from a table's detail at /dashboard/floor. Owners
 * and staff both (S-26). The restaurant comes from the session, the table from
 * the URL, and the form names the session the page showed, as a precondition
 * only. Items not yet delivered or voided are a 409 that lists them and points
 * to force-close; a session that has changed since the page loaded a 409 too;
 * another restaurant's, an archived or a malformed table a 404.
 */
export async function POST(request: NextRequest, context: RouteContext<"/api/floor/[tableId]/clear">) {
  const tenant = await getTenantContext();
  const tableId = z.uuid().safeParse((await context.params).tableId);
  if (!tableId.success) notFound();
  const form = await request.formData().catch(() => new FormData());
  const shown = shownSessionFrom(form);
  if (!shown) return reloadToClose();

  const result = await clearTable(tenant, tableId.data, shown);
  if (result.outcome === "not_found") notFound();
  if (result.outcome === "session_changed") return sessionChanged();
  if (result.outcome === "blocked") return blockedBy(result.items);
  return formSaved(request, "/dashboard/floor");
}
