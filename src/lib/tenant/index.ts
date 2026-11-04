import "server-only";
import { cache } from "react";
import { and, eq } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { forbidden, unauthorized } from "next/navigation";
import { staff } from "@/db/schema";
import { sessionEmail } from "@/lib/auth";
import { findPlatformAdminId, findStaffIdentity } from "@/lib/auth/identity";
import { devAuthBypassEnabled } from "@/lib/env";
import {
  defaultDevIdentity,
  DEV_IDENTITY_COOKIE,
  devPlatformAdmin,
  findDevIdentity,
} from "./dev-identities";
import { type TenantContext, withTenant } from "./scope";

/**
 * The tenant seam (S-25): who is asking. Everything that touches tenant data
 * goes through it or through ./scope, which holds withTenant: ESLint keeps getDb
 * out of the rest of the app. This file loads sign-in, so code on a public route
 * imports ./scope and ./public instead (S-32).
 */

export { type TenantContext, type TenantTransaction, withTenant } from "./scope";

/** The platform admin a real admin session belongs to, if any. */
export async function sessionPlatformAdminId(requestHeaders: Headers) {
  const email = await sessionEmail("admin", requestHeaders);
  return email ? findPlatformAdminId(email) : undefined;
}

/**
 * Who the real session says this is. findStaffIdentity runs on every request,
 * not just at sign-in, so deactivating someone logs them out on their next one.
 * A platform admin has no tenant, so gets the 403 the dev bypass gives them
 * rather than being told they're signed out.
 */
async function sessionIdentity() {
  // First, because reading headers is what keeps pages that call this out of
  // `next build`, which has no secrets to build a session with.
  const requestHeaders = await headers();
  const email = await sessionEmail("staff", requestHeaders);
  const member = email ? await findStaffIdentity(email) : undefined;
  if (!member && (await sessionPlatformAdminId(requestHeaders))) forbidden();
  return member;
}

/**
 * The dev bypass's identity (S-25), if it's on. `next build` compiles this out
 * of production.
 */
export async function currentIdentity() {
  if (!devAuthBypassEnabled()) return undefined;
  const chosen = (await cookies()).get(DEV_IDENTITY_COOKIE);
  if (chosen?.value === devPlatformAdmin.key) return devPlatformAdmin;
  return chosen ? findDevIdentity(chosen.value) : defaultDevIdentity;
}

/**
 * The only source of tenant identity: the restaurant ID always comes from here,
 * never from request input. Ends the request with a 401 for anyone without an
 * active staff record, and a 403 for a platform admin, who has no tenant until
 * entering a restaurant (ticket 1.3).
 */
export const getTenantContext = cache(async (): Promise<TenantContext> => {
  if (!devAuthBypassEnabled()) {
    const member = await sessionIdentity();
    if (!member) unauthorized();
    return member;
  }

  const identity = await currentIdentity();
  if (!identity) unauthorized();
  if ("platformAdminId" in identity) forbidden();

  const { restaurantId, staffId } = identity;
  const [member] = await withTenant({ restaurantId }, (tx) =>
    tx
      .select({ role: staff.role })
      .from(staff)
      .where(
        and(
          eq(staff.restaurantId, restaurantId),
          eq(staff.id, staffId),
          eq(staff.active, true),
        ),
      ),
  );
  if (!member) unauthorized();

  return { restaurantId, staffId, role: member.role };
});

/** Guards owner-only actions (S-26). RLS is tenant-only, so roles live here. */
export function requireOwner(ctx: TenantContext) {
  if (ctx.role !== "owner") forbidden();
}
