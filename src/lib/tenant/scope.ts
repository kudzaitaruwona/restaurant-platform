import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import type { Database } from "@/db/client";

/**
 * The tenant's scope in Postgres, with no idea who is asking. Apart from
 * "@/lib/tenant", which adds who that is and so loads sign-in, this is all a
 * public route needs, and a test keeps it that way (S-32).
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
