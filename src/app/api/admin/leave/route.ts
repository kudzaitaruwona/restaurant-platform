import type { NextRequest } from "next/server";
import { formSaved } from "@/lib/form-response";
import {
  getPlatformAdminContext,
  leaveRestaurant,
} from "@/lib/tenant/platform-admin";

/** "Leave restaurant" on the admin banner. Takes no id: the session knows. */
export async function POST(request: NextRequest) {
  const admin = await getPlatformAdminContext();
  await leaveRestaurant(admin);
  return formSaved(request, "/admin");
}
