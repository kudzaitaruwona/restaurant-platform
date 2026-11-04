import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { staff } from "@/db/schema";
import { getTenantContext, requireOwner, withTenant } from "@/lib/tenant";
import { recordAdminAction } from "@/lib/tenant/audit";

const staffIdParam = z.uuid();
const displayName = z.string().trim().min(1).max(200);

/** One colleague: a platform_admin shadow row is nobody's colleague. */
const colleague = (restaurantId: string, staffId: string) =>
  and(
    eq(staff.restaurantId, restaurantId),
    eq(staff.id, staffId),
    eq(staff.kind, "staff"),
  );

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
      .where(colleague(tenant.restaurantId, staffId)),
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

  const updated = await withTenant(tenant, async (tx) => {
    const renamed = await tx
      .update(staff)
      .set({ displayName: name.data })
      .where(colleague(tenant.restaurantId, staffId))
      .returning({ id: staff.id });
    if (renamed.length > 0) {
      await recordAdminAction(tx, tenant, {
        action: "staff.rename",
        entityType: "staff",
        entityId: staffId,
      });
    }
    return renamed;
  });
  if (updated.length === 0) notFound();

  // Not formSaved(): this is a plain form on /dashboard, not an ActionForm, so
  // it always wants the redirect.
  return new Response(null, { status: 303, headers: { Location: "/dashboard" } });
}
