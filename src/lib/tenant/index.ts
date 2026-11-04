import "server-only";
import { cache } from "react";
import { and, eq, sql } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { forbidden, unauthorized } from "next/navigation";
import { getDb } from "@/db";
import type { Database } from "@/db/client";
import { staff } from "@/db/schema";
import { sessionOf } from "@/lib/auth";
import { findPlatformAdminId, findStaffIdentity } from "@/lib/auth/identity";
import { devAuthBypassEnabled } from "@/lib/env";
import { enteredRestaurant } from "./admin-entry";
import {
  defaultDevIdentity,
  DEV_IDENTITY_COOKIE,
  devPlatformAdmin,
  findDevIdentity,
} from "./dev-identities";

/**
 * The tenant seam (S-25). Everything that touches tenant data goes through
 * here: ESLint keeps getDb out of the rest of the app.
 */

export type TenantContext = {
  restaurantId: string;
  staffId: string;
  role: "owner" | "staff";
  /**
   * Set only for a platform admin who has entered this restaurant: `staffId` is
   * then the shadow row, and this is who really acts. What audit_log records
   * (S-29), so pass the whole context along, not a part of it.
   */
  platformAdminId?: string;
};

export type TenantTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

/**
 * Runs `fn` in a transaction scoped to one restaurant: RLS shows it that
 * tenant's rows and no others. The setting is transaction-local, so it can't
 * leak to the next user of a pooled connection.
 */
export function withTenant<T>(
  ctx: Pick<TenantContext, "restaurantId">,
  fn: (tx: TenantTransaction) => Promise<T>,
): Promise<T> {
  return getDb().transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.restaurant_id', ${ctx.restaurantId}, true)`,
    );
    return fn(tx);
  });
}

/** The platform admin a real admin session belongs to, if any. */
export async function sessionPlatformAdmin(requestHeaders: Headers) {
  const session = await sessionOf("admin", requestHeaders);
  const platformAdminId = session && (await findPlatformAdminId(session.email));
  return platformAdminId ? { platformAdminId, sessionId: session.id } : undefined;
}

/**
 * The tenant a platform admin is inside, if any. The shadow row is always an
 * owner: Postgres won't let it be anything else (staff_shadow_row).
 */
async function enteredContext(admin: {
  platformAdminId: string;
  sessionId: string;
}): Promise<TenantContext | undefined> {
  const entry = await enteredRestaurant(admin.sessionId);
  return entry && {
    ...entry,
    role: "owner",
    platformAdminId: admin.platformAdminId,
  };
}

/**
 * Who the real session says this is. findStaffIdentity runs on every request,
 * not just at sign-in, so deactivating someone logs them out on their next one.
 * Entering a restaurant is a deliberate act, so it wins over a staff session in
 * the same browser. A platform admin who hasn't entered one has no tenant, so
 * gets the 403 the dev bypass gives them rather than being told they're signed
 * out.
 */
async function sessionIdentity(): Promise<TenantContext | undefined> {
  // First, because reading headers is what keeps pages that call this out of
  // `next build`, which has no secrets to build a session with.
  const requestHeaders = await headers();
  const admin = await sessionPlatformAdmin(requestHeaders);
  const entered = admin && (await enteredContext(admin));
  if (entered) return entered;

  const session = await sessionOf("staff", requestHeaders);
  const member = session ? await findStaffIdentity(session.email) : undefined;
  if (!member && admin) forbidden();
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
 * entering a restaurant. Once inside, they get its shadow staff row, as an owner.
 */
export const getTenantContext = cache(async (): Promise<TenantContext> => {
  if (!devAuthBypassEnabled()) {
    const member = await sessionIdentity();
    if (!member) unauthorized();
    return member;
  }

  const identity = await currentIdentity();
  if (!identity) unauthorized();
  if ("platformAdminId" in identity) {
    const entered = await enteredContext(identity);
    if (!entered) forbidden();
    return entered;
  }

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
