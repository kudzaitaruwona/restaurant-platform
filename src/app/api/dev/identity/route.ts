import { and, eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { staff } from "@/db/schema";
import { devAuthBypassEnabled } from "@/lib/env";
import { withTenant } from "@/lib/tenant";
import {
  DEV_IDENTITY_COOKIE,
  findDevIdentity,
} from "@/lib/tenant/dev-identities";

/**
 * The dev switcher (S-25): picks which seeded identity getTenantContext()
 * returns. A 404 unless the bypass is on, so it doesn't exist in production.
 */
export async function POST(request: Request) {
  if (!devAuthBypassEnabled()) notFound();

  const key = (await request.formData()).get("identity");
  const identity = typeof key === "string" ? findDevIdentity(key) : undefined;
  if (!identity) {
    return Response.json({ error: "Unknown identity." }, { status: 400 });
  }

  // getTenantContext() would refuse them on the next request anyway. Refusing
  // here says why, and leaves whoever is switching signed in as they were.
  const { restaurantId, staffId } = identity;
  const [member] = await withTenant({ restaurantId }, (tx) =>
    tx
      .select({ id: staff.id })
      .from(staff)
      .where(
        and(
          eq(staff.restaurantId, restaurantId),
          eq(staff.id, staffId),
          eq(staff.active, true),
        ),
      ),
  );
  if (!member) {
    return Response.json({ error: "That staff member is deactivated." }, { status: 403 });
  }

  (await cookies()).set(DEV_IDENTITY_COOKIE, identity.key, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });
  return new Response(null, { status: 303, headers: { Location: "/dashboard" } });
}
