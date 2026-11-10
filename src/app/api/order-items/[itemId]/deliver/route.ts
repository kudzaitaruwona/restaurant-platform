import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { markItemDelivered, orderItemIdFrom } from "@/lib/floor";
import { formSaved } from "@/lib/form-response";
import { getTenantContext } from "@/lib/tenant";

/**
 * Mark delivered, from a table's detail at /dashboard/floor. Owners and staff
 * both (S-26). The restaurant comes from the session, the line from the URL, and
 * a line of another restaurant is a 404. A line that isn't done is a 409 saying
 * what it is now.
 */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/order-items/[itemId]/deliver">,
) {
  const tenant = await getTenantContext();
  const itemId = await orderItemIdFrom(context.params);

  const result = await markItemDelivered(tenant, itemId);
  if (result.outcome === "not_found") notFound();
  if (result.outcome === "wrong_status") {
    return Response.json(
      {
        error: `Mark delivered didn't apply: this item is ${result.status === "delivered" ? "already delivered" : result.status === "voided" ? "voided" : `still ${result.status}, not done`}. Reload to see the latest.`,
      },
      { status: 409 },
    );
  }
  return formSaved(request, "/dashboard/floor");
}
