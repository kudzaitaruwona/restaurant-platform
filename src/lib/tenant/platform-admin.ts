import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { headers } from "next/headers";
import { forbidden, unauthorized } from "next/navigation";
import { getAdminDb } from "@/db/admin";
import type { currencyMode } from "@/db/schema";
import { sessionOf } from "@/lib/auth";
import { type MetricCounts, metricsFrom } from "@/lib/booking-metrics";
import { findStaffIdentity } from "@/lib/auth/identity";
import { devAuthBypassEnabled } from "@/lib/env";
import { currentIdentity, sessionPlatformAdmin } from "./index";

/**
 * The platform-admin seam: who the admin is, and the only code that calls the
 * privileged database functions (S-28), through its own login. A restaurant id
 * here is the admin's choice of tenant, so unlike tenant code it does come from
 * the request. Tenant code never sees it.
 */

export type PlatformAdminContext = { platformAdminId: string; sessionId: string };

export type CurrencyMode = (typeof currencyMode.enumValues)[number];

/**
 * The only source of platform-admin identity, as getTenantContext() is for
 * tenants. Ends the request with a 401 for anyone without an identity, and a 403
 * for restaurant staff. A separate session from staff (D-07), and the admin row
 * is checked every time, so removing it ends the session on the next request.
 */
export async function getPlatformAdminContext(): Promise<PlatformAdminContext> {
  if (devAuthBypassEnabled()) {
    const identity = await currentIdentity();
    if (!identity) unauthorized();
    if (!("platformAdminId" in identity)) forbidden();

    const { platformAdminId, sessionId } = identity;
    return { platformAdminId, sessionId };
  }

  const requestHeaders = await headers();

  const admin = await sessionPlatformAdmin(requestHeaders);
  if (admin) return admin;

  const session = await sessionOf("staff", requestHeaders);
  if (session && (await findStaffIdentity(session.email))) forbidden();
  unauthorized();
}

export const DEFAULT_TIMEZONE = "Africa/Harare";

const UNIQUE_VIOLATION = "23505";
const INVALID_PARAMETER = "22023";
const NO_DATA_FOUND = "P0002";
const ALREADY_HAS_STAFF = "PA001";

/**
 * Runs a privileged function that returns a new row's id (S-28). These functions
 * are one statement and refuse to run inside a tenant, so there's no withTenant:
 * app_admin reaches these rows through the functions alone.
 */
async function createdId<Problem extends string>(
  query: SQL,
  problems: Record<string, Problem>,
): Promise<{ id: string } | { problem: Problem }> {
  try {
    const { rows } = await getAdminDb().execute<{ id: string }>(query);
    return { id: rows[0].id };
  } catch (error) {
    const { code } = (error as { cause?: { code?: string } }).cause ?? {};
    if (code && code in problems) return { problem: problems[code] };
    throw error;
  }
}

type Admin = Pick<PlatformAdminContext, "platformAdminId">;

export function createRestaurant(
  admin: Admin,
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
  admin: Admin,
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

/**
 * Takes this admin session into a restaurant (spec 01). The restaurant is held
 * against the session, in Postgres, so later requests get it from
 * getTenantContext() and never from the browser. Returns the shadow staff row,
 * which the function makes on the first entry, and audits every entry.
 */
export function enterRestaurant(admin: PlatformAdminContext, restaurantId: string) {
  return createdId(
    sql`select platform_enter_restaurant(${admin.platformAdminId}, ${admin.sessionId}, ${restaurantId}) as id`,
    { [NO_DATA_FOUND]: "no_restaurant" },
  );
}

/** Takes this admin session back out, if it's in one. The shadow row stays. */
export async function leaveRestaurant(admin: PlatformAdminContext) {
  await getAdminDb().execute(
    sql`select platform_leave_restaurant(${admin.platformAdminId}, ${admin.sessionId})`,
  );
}

/**
 * Signing out is someone acting, so it's audited as leaving, unlike a session
 * that ends on its own (S-28). Better Auth calls this before it deletes the
 * session, because the entry goes with the session and nothing records that.
 */
export async function leaveOnSignOut(requestHeaders: Headers) {
  const admin = await sessionPlatformAdmin(requestHeaders);
  if (admin) await leaveRestaurant(admin);
}

export async function listRestaurants(admin: Admin) {
  const { rows } = await getAdminDb().execute<{
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

/**
 * Every restaurant's booking success metrics, by restaurant id, in one statement.
 * platform_list_booking_metrics runs the same booking_success_metrics() a
 * restaurant's own dashboard does, so the two can't disagree.
 */
export async function listBookingMetrics(admin: Admin) {
  const { rows } = await getAdminDb().execute<MetricCounts & { restaurant_id: string }>(
    sql`select * from platform_list_booking_metrics(${admin.platformAdminId})`,
  );
  return new Map(rows.map(({ restaurant_id, ...counts }) => [restaurant_id, metricsFrom(counts)]));
}
