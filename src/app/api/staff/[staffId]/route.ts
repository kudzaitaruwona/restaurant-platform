import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { staff } from "@/db/schema";
import { getTenantContext, requireOwner, withTenant } from "@/lib/tenant";

const staffIdParam = z.uuid();
const displayName = z.string().trim().min(1).max(200);

async function staffIdFrom(context: RouteContext<"/api/staff/[staffId]">) {
  const { staffId } = await context.params;
  const parsed = staffIdParam.safeParse(staffId);
  if (!parsed.success) notFound();
  return parsed.data;
}

/** One colleague in the caller's restaurant. Owner or staff. */
export async function GET(
  _request: NextRequest,
  context: RouteContext<"/api/staff/[staffId]">,
) {
  const tenant = await getTenantContext();
  const staffId = await staffIdFrom(context);

  const [member] = await withTenant(tenant, (tx) =>
    tx
      .select({
        id: staff.id,
        displayName: staff.displayName,
        role: staff.role,
      })
      .from(staff)
      .where(
        and(eq(staff.restaurantId, tenant.restaurantId), eq(staff.id, staffId)),
      ),
  );
  if (!member) notFound();

  return Response.json(member);
}

/**
 * Renames a colleague: the example owner-only action, posted by the form on
 * /dashboard. Staff management is owner only (S-26).
 */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/staff/[staffId]">,
) {
  const tenant = await getTenantContext();
  requireOwner(tenant);
  const staffId = await staffIdFrom(context);

  const name = displayName.safeParse((await request.formData()).get("displayName"));
  if (!name.success) {
    return Response.json({ error: "Enter a name." }, { status: 400 });
  }

  const updated = await withTenant(tenant, (tx) =>
    tx
      .update(staff)
      .set({ displayName: name.data })
      .where(
        and(eq(staff.restaurantId, tenant.restaurantId), eq(staff.id, staffId)),
      )
      .returning({ id: staff.id }),
  );
  if (updated.length === 0) notFound();

  return new Response(null, { status: 303, headers: { Location: "/dashboard" } });
}
