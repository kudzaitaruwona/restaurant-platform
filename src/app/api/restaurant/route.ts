import type { NextRequest } from "next/server";
import { formSaved } from "@/lib/form-response";
import {
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

  await updateRestaurantSettings(tenant, settings.data);

  return formSaved(request, "/dashboard/settings");
}
