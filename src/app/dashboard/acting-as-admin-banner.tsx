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
      className="flex flex-wrap print:hidden items-center justify-between gap-2 bg-primary px-4 py-2 text-sm text-primary-foreground"
    >
      <p>Acting as admin in {restaurant.name}</p>
      <form method="post" action="/api/admin/leave">
        <Button type="submit" variant="secondary" size="sm">
          Leave restaurant
        </Button>
      </form>
    </div>
  );
}
