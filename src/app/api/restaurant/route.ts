import type { NextRequest } from "next/server";
import { formSaved } from "@/lib/form-response";
import {
  invalidTimezoneMessage,
  parseRestaurantSettings,
  updateRestaurantSettings,
} from "@/lib/restaurant-settings";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/** Saves the settings form on /dashboard/settings. Owner only (S-26). */
export async function POST(request: NextRequest) {
  const tenant = await getTenantContext();
  requireOwner(tenant);

  const settings = parseRestaurantSettings(
    await request.formData().catch(() => new FormData()),
  );
  if (!settings.success) {
    return Response.json({ error: settings.message }, { status: 400 });
  }

  if ((await updateRestaurantSettings(tenant, settings.data)) === "invalid_timezone") {
    return Response.json({ error: invalidTimezoneMessage }, { status: 400 });
  }

  return formSaved(request, "/dashboard/settings");
}
