import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { formSaved } from "@/lib/form-response";
import { parseAvailability, setItemAvailability } from "@/lib/menu";
import { getTenantContext } from "@/lib/tenant";

/**
 * Marks an item sold out, or back on, from /dashboard/menu. Owners and staff
 * both may (S-26). It's a route of its own so that nothing else about an item
 * is reachable by staff: the owner-only item routes keep their requireOwner.
 */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/menu/items/[itemId]/availability">,
) {
  const tenant = await getTenantContext();
  const { itemId } = await context.params;

  const availability = parseAvailability(
    await request.formData().catch(() => new FormData()),
  );
  if (!availability.success) {
    return Response.json({ error: availability.message }, { status: 400 });
  }

  if ((await setItemAvailability(tenant, itemId, availability.data)) === "no_such_item") {
    notFound();
  }
  return formSaved(request, "/dashboard/menu");
}
