import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { inviteResponse } from "@/lib/invite-responses";
import {
  getPlatformAdminContext,
  resendOwnerInvite,
} from "@/lib/tenant/platform-admin";

const ids = z.object({ restaurantId: z.uuid(), staffId: z.uuid() });

/**
 * "Send invite again" on a restaurant's owner card on /admin (S-42). The
 * restaurant comes from the URL because the admin is choosing a tenant, and both
 * ids stop at platform_start_owner_invite, which only reaches an active owner of
 * that restaurant who hasn't signed in yet (S-28).
 */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/admin/restaurants/[restaurantId]/invite">,
) {
  const admin = await getPlatformAdminContext();

  const { restaurantId } = await context.params;
  const form = await request.formData().catch(() => new FormData());
  const input = ids.safeParse({ restaurantId, staffId: form.get("staffId") });
  if (!input.success) notFound();

  return inviteResponse(
    await resendOwnerInvite(admin, input.data.restaurantId, input.data.staffId),
    () => new Response(null, { status: 204 }),
  );
}
