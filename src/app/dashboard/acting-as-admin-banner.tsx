import { eq } from "drizzle-orm";
import { Button } from "@/components/ui/button";
import { restaurants } from "@/db/schema";
import { getTenantContext, withTenant } from "@/lib/tenant";

/**
 * Says so whenever a platform admin is inside a restaurant (spec 01), on every
 * staff page except on paper: a printed sheet is for the tables, not the admin. A plain form, so leaving lands on /admin rather than refreshing a
 * page they're no longer allowed to see.
 */
export async function ActingAsAdminBanner() {
  const tenant = await getTenantContext();
  if (!tenant.platformAdminId) return null;

  const [restaurant] = await withTenant(tenant, (tx) =>
    tx
      .select({ name: restaurants.name })
      .from(restaurants)
      .where(eq(restaurants.id, tenant.restaurantId)),
  );

  return (
    <div
      role="status"
      data-admin-bar
      className="sticky top-0 z-50 flex h-11 shrink-0 items-center justify-between gap-3 bg-ink pr-2 pl-4 text-caption font-medium text-page md:pl-5 md:text-body print:hidden"
    >
      <p className="min-w-0 truncate">Acting as admin in {restaurant.name}</p>
      <form method="post" action="/api/admin/leave">
        <Button
          type="submit"
          variant="ghost"
          size="compact"
          className="h-9 border-page/40 text-caption text-page hover:bg-page/15"
        >
          Leave restaurant
        </Button>
      </form>
    </div>
  );
}
