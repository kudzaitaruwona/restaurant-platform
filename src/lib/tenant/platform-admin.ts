import "server-only";
import { headers } from "next/headers";
import { forbidden, unauthorized } from "next/navigation";
import { sessionEmail } from "@/lib/auth";
import { findPlatformAdminId, findStaffIdentity } from "@/lib/auth/identity";

/**
 * The platform admin behind this request. A separate session from staff (D-07):
 * 401 with no identity, 403 for someone who is restaurant staff. The admin row
 * is checked every time, so removing it ends the session on the next request.
 */
export async function getPlatformAdminContext(): Promise<{
  platformAdminId: string;
}> {
  const requestHeaders = await headers();

  const adminEmail = await sessionEmail("admin", requestHeaders);
  const platformAdminId = adminEmail && (await findPlatformAdminId(adminEmail));
  if (platformAdminId) return { platformAdminId };

  const staffEmail = await sessionEmail("staff", requestHeaders);
  if (staffEmail && (await findStaffIdentity(staffEmail))) forbidden();
  unauthorized();
}
