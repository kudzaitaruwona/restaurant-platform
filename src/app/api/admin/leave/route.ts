import {
  getPlatformAdminContext,
  leaveRestaurant,
} from "@/lib/tenant/platform-admin";

/** "Leave restaurant" on the admin banner. Takes no id: the session knows. */
export async function POST() {
  const admin = await getPlatformAdminContext();
  await leaveRestaurant(admin);
  return new Response(null, { status: 303, headers: { Location: "/admin" } });
}
