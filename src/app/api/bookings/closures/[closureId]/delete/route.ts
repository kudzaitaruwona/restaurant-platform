import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { closureIdFrom, deleteClosure } from "@/lib/booking-closures";
import { formSaved } from "@/lib/form-response";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/**
 * Removes a closure, from /dashboard/bookings/settings. Owner only (S-26). Its
 * times can be booked again at once.
 */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/bookings/closures/[closureId]/delete">,
) {
  const tenant = await getTenantContext();
  requireOwner(tenant);
  const closureId = await closureIdFrom(context.params);

  if ((await deleteClosure(tenant, closureId)) === "not_found") notFound();
  return formSaved(request, "/dashboard/bookings/settings");
}
