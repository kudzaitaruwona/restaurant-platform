import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { orderItemIdFrom } from "@/lib/floor";
import { formSaved } from "@/lib/form-response";
import { voidReasonFrom } from "@/lib/kitchen-board";
import { getTenantContext } from "@/lib/tenant";
import { voidItem } from "@/lib/voids";

const headers = { "cache-control": "no-store" };

/**
 * Void one item (#73, S-36), from a kitchen card's menu or a table's detail at
 * /dashboard/floor. Owners and staff both (S-26). The restaurant comes from the
 * session, the item from the URL, and the reason from the form: blank or over
 * 200 characters is a 400. Another restaurant's item is a 404; a delivered or
 * already voided one a 409 saying which.
 */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/order-items/[itemId]/void">,
) {
  const tenant = await getTenantContext();
  const itemId = await orderItemIdFrom(context.params);
  const form = await request.formData().catch(() => new FormData());
  const reason = voidReasonFrom(form.get("reason"));
  if (!reason) {
    return Response.json(
      { error: "Give a reason for the void, up to 200 characters." },
      { status: 400, headers },
    );
  }

  const result = await voidItem(tenant, itemId, reason);
  if (result.outcome === "not_found") notFound();
  if (result.outcome === "wrong_status") {
    return Response.json(
      {
        error:
          result.status === "delivered"
            ? "This item is delivered, so it can't be voided."
            : "This item is already voided.",
        status: result.status,
      },
      { status: 409, headers },
    );
  }
  return formSaved(request, "/dashboard/floor");
}
