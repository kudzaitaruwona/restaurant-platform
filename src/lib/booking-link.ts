import "server-only";
import { eq } from "drizzle-orm";
import { bookingSettings, restaurants } from "@/db/schema";
import type { PublicTenant } from "@/lib/tenant/public";
import { withTenant } from "@/lib/tenant/scope";

/**
 * The guest's booking page (spec 04), by the restaurant's slug. The public table
 * page and the settings screen both build their link from this, so they can't
 * disagree. It imports only the public seam and the tenant scope, never
 * `@/lib/tenant`, so the public path doesn't load Better Auth (S-32).
 */
export const bookingPagePath = (slug: string) => `/r/${encodeURIComponent(slug)}/book`;

/**
 * Where a table page's "Book again" link leads, or null while online booking is
 * off (proposed, spec 03): a link to a closed page is worse than none. It's read
 * inside the public page's cache, so turning booking on or off must refresh that
 * page (revalidateMenu, in setBookingEnabled).
 */
export async function bookAgainPath(tenant: PublicTenant): Promise<string | null> {
  const [row] = await withTenant(tenant, (tx) =>
    tx
      .select({ slug: restaurants.slug, enabled: bookingSettings.enabled })
      .from(restaurants)
      .innerJoin(bookingSettings, eq(bookingSettings.restaurantId, restaurants.id))
      .where(eq(restaurants.id, tenant.restaurantId)),
  );
  return row?.enabled ? bookingPagePath(row.slug) : null;
}
