import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { forceCloseTable } from "@/lib/closing";
import {
  headers,
  itemsChanged,
  reloadToClose,
  sessionChanged,
  shownItemsFrom,
  shownSessionFrom,
} from "@/lib/closing-responses";
import { formSaved } from "@/lib/form-response";
import { voidReasonFrom } from "@/lib/kitchen-board";
import { getTenantContext } from "@/lib/tenant";

/**
 * Force-close (spec 06, #74), from a table's detail at /dashboard/floor: void
 * every outstanding item with one reason, then close, in one transaction,
 * audited. Owners and staff both (S-26). The reason is a void's: trimmed, not
 * blank and up to 200 characters, or a 400 that changes nothing. The form names
 * the session and the outstanding items (`item`, once each) the page showed, as
 * preconditions only; if either has changed since it is a 409, with the items
 * now outstanding (#95), and another restaurant's, an archived or a malformed
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
  const shownItems = shownItemsFrom(form);
  if (!shown || !shownItems) return reloadToClose();

  const result = await forceCloseTable(tenant, tableId.data, shown, shownItems, reason);
  if (result.outcome === "not_found") notFound();
  if (result.outcome === "session_changed") return sessionChanged();
  if (result.outcome === "items_changed") return itemsChanged(result.items);
  return formSaved(request, "/dashboard/floor");
}
