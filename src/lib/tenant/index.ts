import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { forbidden, unauthorized } from "next/navigation";
import { getDb } from "@/db";
import type { Database } from "@/db/client";
import { staff } from "@/db/schema";
import { devAuthBypassEnabled } from "@/lib/env";
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

/**
 * Who is signed in. Real login (ticket 1.6) replaces this function and nothing
 * else. Until then, the only identities are the dev bypass's.
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
export async function getTenantContext(): Promise<TenantContext> {
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
}

/** Guards owner-only actions (S-26). RLS is tenant-only, so roles live here. */
export function requireOwner(ctx: TenantContext) {
  if (ctx.role !== "owner") forbidden();
}
