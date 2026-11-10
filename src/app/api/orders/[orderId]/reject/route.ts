import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { formSaved } from "@/lib/form-response";
import { voidReasonFrom } from "@/lib/kitchen-board";
import { getTenantContext } from "@/lib/tenant";
import { rejectOrder } from "@/lib/voids";

const headers = { "cache-control": "no-store" };

/**
 * Reject an order (#73, S-36): void every item of it not yet delivered, with one
 * reason, from a kitchen card's menu or a table's detail at /dashboard/floor.
 * Owners and staff both (S-26). The restaurant comes from the session, the
 * order from the URL. A blank or over-long reason is a 400; another
 * restaurant's or a malformed order a 404; an order with nothing left to void
 * a 409.
 */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/orders/[orderId]/reject">,
) {
  const tenant = await getTenantContext();
  const orderId = z.uuid().safeParse((await context.params).orderId);
  if (!orderId.success) notFound();
  const form = await request.formData().catch(() => new FormData());
  const reason = voidReasonFrom(form.get("reason"));
  if (!reason) {
    return Response.json(
      { error: "Give a reason for rejecting the order, up to 200 characters." },
      { status: 400, headers },
    );
  }

  const result = await rejectOrder(tenant, orderId.data, reason);
  if (result.outcome === "not_found") notFound();
  if (result.outcome === "nothing_to_void") {
    return Response.json(
      { error: "Nothing left to reject: every item of this order is delivered or voided." },
      { status: 409, headers },
    );
  }
  return formSaved(request, "/dashboard/floor");
}
