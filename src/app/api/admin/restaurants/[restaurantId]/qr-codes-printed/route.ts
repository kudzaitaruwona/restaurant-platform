import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  getPlatformAdminContext,
  setQrCodesPrinted,
} from "@/lib/tenant/platform-admin";

const restaurantIdParam = z.uuid();
const input = z.object({ printed: z.enum(["true", "false"]) });

/**
 * Ticks or unticks "QR codes printed" on a restaurant's onboarding checklist
 * (spec 01), the one item that isn't derived from its data. The id comes from
 * the URL because the admin is choosing a tenant, and it stops at the function
 * that writes and audits the tick (S-28).
 */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/admin/restaurants/[restaurantId]/qr-codes-printed">,
) {
  const admin = await getPlatformAdminContext();

  const { restaurantId } = await context.params;
  const id = restaurantIdParam.safeParse(restaurantId);
  if (!id.success) notFound();

  const fields = input.safeParse(Object.fromEntries(await request.formData()));
  if (!fields.success) {
    return Response.json({ error: "Tick or untick it." }, { status: 400 });
  }
  const printed = fields.data.printed === "true";

  const result = await setQrCodesPrinted(admin, id.data, printed);
  if (result.problem) notFound();

  return Response.json({ printed });
}
