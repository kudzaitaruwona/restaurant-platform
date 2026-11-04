import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { forbidden, unauthorized } from "next/navigation";
import { getDb } from "@/db";
import type { currencyMode } from "@/db/schema";
import { currentIdentity } from "./index";

/**
 * The platform-admin seam: who the admin is, and the only code that calls the
 * privileged database functions (S-28). A restaurant id here is the admin's
 * choice of tenant, so unlike tenant code it does come from the request. Tenant
 * code never sees it.
 */

export type PlatformAdminContext = { platformAdminId: string };

export type CurrencyMode = (typeof currencyMode.enumValues)[number];

/**
 * The only source of platform-admin identity, as getTenantContext() is for
 * tenants. Ends the request with a 401 for anyone without an identity, and a 403
 * for restaurant staff.
 */
export async function getPlatformAdminContext(): Promise<PlatformAdminContext> {
  const identity = await currentIdentity();
  if (!identity) unauthorized();
  if (!("platformAdminId" in identity)) forbidden();

  return { platformAdminId: identity.platformAdminId };
}

export const DEFAULT_TIMEZONE = "Africa/Harare";

const UNIQUE_VIOLATION = "23505";
const INVALID_PARAMETER = "22023";
const NO_DATA_FOUND = "P0002";
const ALREADY_HAS_STAFF = "PA001";

/**
 * Runs a privileged function that returns a new row's id (S-28). These functions
 * are one statement and refuse to run inside a tenant, so there's no withTenant:
 * outside it, app_tenant reaches these rows through the functions alone.
 */
async function createdId<Problem extends string>(
  query: SQL,
  problems: Record<string, Problem>,
): Promise<{ id: string } | { problem: Problem }> {
  try {
    const { rows } = await getDb().execute<{ id: string }>(query);
    return { id: rows[0].id };
  } catch (error) {
    const { code } = (error as { cause?: { code?: string } }).cause ?? {};
    if (code && code in problems) return { problem: problems[code] };
    throw error;
  }
}

export function createRestaurant(
  admin: PlatformAdminContext,
  restaurant: {
    name: string;
    slug: string;
    timezone: string;
    currencyMode: CurrencyMode;
  },
) {
  const { name, slug, timezone, currencyMode } = restaurant;
  return createdId(
    sql`select platform_create_restaurant(${admin.platformAdminId}, ${name}, ${slug}, ${timezone}, ${currencyMode}) as id`,
    {
      [UNIQUE_VIOLATION]: "slug_taken",
      [INVALID_PARAMETER]: "unknown_timezone",
    },
  );
}

/** Makes a restaurant's first staff record, its owner (S-26), and audits it. */
export function createFirstOwner(
  admin: PlatformAdminContext,
  restaurantId: string,
  owner: { email: string; displayName: string },
) {
  return createdId(
    sql`select platform_create_first_owner(${admin.platformAdminId}, ${restaurantId}, ${owner.email}, ${owner.displayName}) as id`,
    {
      [UNIQUE_VIOLATION]: "email_taken",
      [NO_DATA_FOUND]: "no_restaurant",
      [ALREADY_HAS_STAFF]: "has_staff",
    },
  );
}

export async function listRestaurants(admin: PlatformAdminContext) {
  const { rows } = await getDb().execute<{
    id: string;
    name: string;
    slug: string;
    timezone: string;
    currency_mode: CurrencyMode;
    has_owner: boolean;
  }>(sql`select * from platform_list_restaurants(${admin.platformAdminId})`);
  return rows.map(({ currency_mode, has_owner, ...restaurant }) => ({
    ...restaurant,
    currencyMode: currency_mode,
    hasOwner: has_owner,
  }));
}
