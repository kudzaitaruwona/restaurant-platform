import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { forceCloseTable } from "@/lib/closing";
import { headers, reloadToClose, sessionChanged, shownSessionFrom } from "@/lib/closing-responses";
import { formSaved } from "@/lib/form-response";
import { voidReasonFrom } from "@/lib/kitchen-board";
import { getTenantContext } from "@/lib/tenant";

/**
 * Force-close (spec 06, #74), from a table's detail at /dashboard/floor: void
 * every outstanding item with one reason, then close, in one transaction,
 * audited. Owners and staff both (S-26). The reason is a void's: trimmed, not
 * blank and up to 200 characters, or a 400 that changes nothing. The form names
 * the session the page showed, as a precondition only; a session that has
 * changed since is a 409, and another restaurant's, an archived or a malformed
 * table a 404.
 */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/floor/[tableId]/force-close">,
) {
  const tenant = await getTenantContext();
  const tableId = z.uuid().safeParse((await context.params).tableId);
  if (!tableId.success) notFound();
  const form = await request.formData().catch(() => new FormData());
  const reason = voidReasonFrom(form.get("reason"));
  if (!reason) {
    return Response.json(
      { error: "Give a reason for force-closing the table, up to 200 characters." },
      { status: 400, headers },
    );
  }
  const shown = shownSessionFrom(form);
  if (!shown) return reloadToClose();

  const result = await forceCloseTable(tenant, tableId.data, shown, reason);
  if (result.outcome === "not_found") notFound();
  if (result.outcome === "session_changed") return sessionChanged();
  return formSaved(request, "/dashboard/floor");
}
