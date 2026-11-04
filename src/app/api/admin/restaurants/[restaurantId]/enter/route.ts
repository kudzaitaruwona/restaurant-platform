import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  enterRestaurant,
  getPlatformAdminContext,
} from "@/lib/tenant/platform-admin";

const restaurantIdParam = z.uuid();

/**
 * "Enter restaurant" on /admin (spec 01). The id comes from the URL because the
 * admin is choosing a tenant, and it stops here: it goes to the function that
 * holds the choice against the session, and every later request gets the tenant
 * from getTenantContext() (S-28).
 */
export async function POST(
  _request: NextRequest,
  context: RouteContext<"/api/admin/restaurants/[restaurantId]/enter">,
) {
  const admin = await getPlatformAdminContext();

  const { restaurantId } = await context.params;
  const id = restaurantIdParam.safeParse(restaurantId);
  if (!id.success) notFound();

  const result = await enterRestaurant(admin, id.data);
  if ("problem" in result) notFound();

  return new Response(null, { status: 303, headers: { Location: "/dashboard" } });
}
