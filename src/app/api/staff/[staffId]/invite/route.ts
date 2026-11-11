import type { NextRequest } from "next/server";
import { formSaved } from "@/lib/form-response";
import { inviteResponse } from "@/lib/invite-responses";
import { resendInvite } from "@/lib/staff-management";
import { staffIdFrom } from "@/lib/staff-responses";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/** "Send invite again" from /dashboard/staff (S-42). Owner only, as all staff management (S-26). */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/staff/[staffId]/invite">,
) {
  const tenant = await getTenantContext();
  requireOwner(tenant);
  const staffId = await staffIdFrom(context.params);

  return inviteResponse(await resendInvite(tenant, staffId), () =>
    formSaved(request, "/dashboard/staff"),
  );
}
