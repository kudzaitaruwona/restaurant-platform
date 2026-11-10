import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { reopenSession } from "@/lib/closing";
import { reopenRefused, reloadToClose, shownSessionFrom } from "@/lib/closing-responses";
import { formSaved } from "@/lib/form-response";
import { getTenantContext } from "@/lib/tenant";

/**
 * Reopen (spec 06, #76), from a free table's detail at /dashboard/floor, within
 * 15 minutes of the session's close and only if no party has opened the table
 * since. Owners and staff both (S-26); audited. The restaurant comes from the
 * session, the table from the URL, and the form names the closed session the
 * page offered. Postgres decides the window and the newer party (trigger
 * table_sessions_reopen): either refusal is a 409 that says which, as is a
 * session no longer closed or not this table's; another restaurant's, an
 * archived or a malformed table is a 404.
 */
export async function POST(request: NextRequest, context: RouteContext<"/api/floor/[tableId]/reopen">) {
  const tenant = await getTenantContext();
  const tableId = z.uuid().safeParse((await context.params).tableId);
  if (!tableId.success) notFound();
  const form = await request.formData().catch(() => new FormData());
  const shown = shownSessionFrom(form);
  if (!shown) return reloadToClose();

  const result = await reopenSession(tenant, tableId.data, shown);
  if (result.outcome === "not_found") notFound();
  if (result.outcome !== "done") return reopenRefused(result.outcome);
  return formSaved(request, `/dashboard/floor/${tableId.data}`);
}
