import type { NextRequest } from "next/server";
import { changeStaffRole, parseRole } from "@/lib/staff-management";
import { staffChangeResponse, staffIdFrom } from "@/lib/staff-responses";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/** Changes a colleague's role, from /dashboard/staff. Owner only (S-26). */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/staff/[staffId]/role">,
) {
  const tenant = await getTenantContext();
  requireOwner(tenant);
  const staffId = await staffIdFrom(context.params);

  const role = parseRole(await request.formData().catch(() => new FormData()));
  if (!role.success) {
    return Response.json({ error: role.message }, { status: 400 });
  }

  return staffChangeResponse(
    await changeStaffRole(tenant, staffId, role.data),
    request,
  );
}
