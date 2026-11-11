import { and, eq } from "drizzle-orm";
import { restaurants, staff } from "@/db/schema";
import { latestRate } from "@/lib/exchange-rate";
import { rateAge, rateAgeLabel } from "@/lib/pricing";
import { getTenantContext, withTenant } from "@/lib/tenant";
import { SessionControls } from "../session-controls";
import { type RailRate, StaffNavigation } from "./staff-rail";

/**
 * Loads what the staff navigation shows (S-41): the restaurant, who is signed
 * in, and for owners the exchange rate, the way the dashboard did (S-26). The
 * same tenant seam as every staff page, so it refuses the same people.
 */
export async function StaffNav() {
  const tenant = await getTenantContext();
  const { restaurant, me, rate } = await withTenant(tenant, async (tx) => {
    const [restaurant] = await tx
      .select({ name: restaurants.name })
      .from(restaurants)
      .where(eq(restaurants.id, tenant.restaurantId));
    const [me] = tenant.platformAdminId
      ? []
      : await tx
          .select({ displayName: staff.displayName })
          .from(staff)
          .where(and(eq(staff.restaurantId, tenant.restaurantId), eq(staff.id, tenant.staffId)));
    const rate = tenant.role === "owner" ? await latestRate(tx, tenant.restaurantId) : null;
    return { restaurant, me, rate };
  });

  const person = tenant.platformAdminId
    ? { name: "Platform admin", detail: "Owner access" }
    : { name: me?.displayName ?? "", detail: tenant.role === "owner" ? "Owner" : "Staff" };

  let railRate: RailRate | undefined;
  if (tenant.role === "owner") {
    const age = rate && rateAge(rate.setAt, new Date());
    railRate = {
      value: rate?.usdToZig ?? null,
      age: age ? rateAgeLabel(age.days) : null,
      stale: age?.stale ?? false,
    };
  }

  return (
    <StaffNavigation
      restaurantName={restaurant.name}
      role={tenant.role}
      person={person}
      rate={railRate}
      session={await SessionControls()}
    />
  );
}

/** Holds the navigation's place while it loads, so nothing shifts. */
export function StaffNavPlaceholder() {
  return (
    <>
      <div aria-hidden className="hidden border-r border-line bg-surface md:block print:hidden" />
      <div aria-hidden className="h-14 border-b border-line bg-surface md:hidden print:hidden" />
    </>
  );
}
