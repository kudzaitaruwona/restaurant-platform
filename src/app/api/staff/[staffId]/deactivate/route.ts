import type { NextRequest } from "next/server";
import { deactivateStaff } from "@/lib/staff-management";
import { staffChangeResponse, staffIdFrom } from "@/lib/staff-responses";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/** Deactivates a colleague, from /dashboard/staff. Owner only (S-26). */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/staff/[staffId]/deactivate">,
) {
  const tenant = await getTenantContext();
  requireOwner(tenant);
  const staffId = await staffIdFrom(context.params);

  return staffChangeResponse(await deactivateStaff(tenant, staffId), request);
}
