import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { headers } from "next/headers";
import { forbidden, unauthorized } from "next/navigation";
import { getAdminDb } from "@/db/admin";
import type { currencyMode } from "@/db/schema";
import { sessionOf } from "@/lib/auth";
import { ownerInviteEmail } from "@/lib/auth/email";
import { type MetricCounts, metricsFrom } from "@/lib/booking-metrics";
import { findStaffIdentity } from "@/lib/auth/identity";
import { devAuthBypassEnabled } from "@/lib/env";
import {
  ALREADY_JOINED,
  appUrl,
  deliverInvite,
  type ResendOutcome,
  sqlStateOf,
  TOO_MANY_INVITES,
} from "@/lib/invites";
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

/**
 * Makes a restaurant's first staff record, its owner (S-26), and audits it, then
 * emails them an invite (S-42). The owner stays whether or not the email goes;
 * `invited` says whether it did, and the owner card offers it again.
 */
export async function createFirstOwner(
  admin: Admin,
  restaurantId: string,
  owner: { email: string; displayName: string },
): Promise<{ id: string; invited: boolean } | { problem: "email_taken" | "no_restaurant" | "has_staff" }> {
  const created = await createdId(
    sql`select platform_create_first_owner(${admin.platformAdminId}, ${restaurantId}, ${owner.email}, ${owner.displayName}) as id`,
    {
      [UNIQUE_VIOLATION]: "email_taken",
      [NO_DATA_FOUND]: "no_restaurant",
      [ALREADY_HAS_STAFF]: "has_staff",
    },
  );
  if ("problem" in created) return created;
  const invited = await inviteOwner(admin, restaurantId, created.id, false);
  return { id: created.id, invited: invited === "sent" };
}

/** "Send invite again" on the owner card: audited, at most 3 an hour per person. */
export const resendOwnerInvite = (admin: Admin, restaurantId: string, staffId: string) =>
  inviteOwner(admin, restaurantId, staffId, true);

async function inviteOwner(
  admin: Admin,
  restaurantId: string,
  staffId: string,
  resend: boolean,
): Promise<ResendOutcome> {
  let invite;
  try {
    const { rows } = await getAdminDb().execute<{
      invite_id: string;
      email: string;
      display_name: string;
      restaurant_name: string;
    }>(
      sql`select * from platform_start_owner_invite(${admin.platformAdminId}, ${restaurantId}, ${staffId}, ${resend})`,
    );
    invite = rows[0];
  } catch (error) {
    const code = sqlStateOf(error);
    if (code === NO_DATA_FOUND) return "not_found";
    if (code === ALREADY_JOINED) return "joined";
    if (code === TOO_MANY_INVITES) return "too_many";
    throw error;
  }

  const delivered = await deliverInvite(
    ownerInviteEmail({
      to: invite.email,
      name: invite.display_name,
      restaurantName: invite.restaurant_name,
      appUrl: appUrl(),
    }),
  );
  await getAdminDb().execute(
    sql`select platform_finish_invite(${admin.platformAdminId}, ${restaurantId}, ${invite.invite_id}, ${delivered})`,
  );
  return delivered ? "sent" : "not_sent";
}

export type OwnerOnCard = {
  id: string;
  displayName: string;
  email: string;
  /** Joined (S-42): null until their first sign-in. */
  firstSignedInAt: Date | null;
  /** Their latest invite; null if none was ever sent (an owner from before S-42). */
  invite: { sentAt: Date; delivered: boolean | null } | null;
};

/** Every restaurant's active owners, by restaurant id, for the owner card. */
export async function listOwners(admin: Admin) {
  const { rows } = await getAdminDb().execute<{
    restaurant_id: string;
    staff_id: string;
    display_name: string;
    email: string;
    first_signed_in_at: string | null;
    invited_at: string | null;
    invite_delivered: boolean | null;
  }>(sql`select * from platform_list_owners(${admin.platformAdminId})`);
  const owners = new Map<string, OwnerOnCard[]>();
  for (const row of rows) {
    const list = owners.get(row.restaurant_id) ?? [];
    list.push({
      id: row.staff_id,
      displayName: row.display_name,
      email: row.email,
      firstSignedInAt: row.first_signed_in_at ? new Date(row.first_signed_in_at) : null,
      invite: row.invited_at
        ? { sentAt: new Date(row.invited_at), delivered: row.invite_delivered }
        : null,
    });
    owners.set(row.restaurant_id, list);
  }
  return owners;
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

/** The items on a restaurant's onboarding checklist (spec 01), in display order. */
export const onboardingItems = [
  { key: "menuEntered", label: "Menu entered" },
  { key: "photos", label: "Photos" },
  { key: "exchangeRateSet", label: "Exchange rate set" },
  { key: "tablesAdded", label: "Tables added" },
  { key: "qrCodesPrinted", label: "QR codes printed" },
  { key: "bookingHoursSet", label: "Booking hours set" },
  { key: "bookingEnabled", label: "Booking enabled" },
] as const;

export type OnboardingChecklist = Record<(typeof onboardingItems)[number]["key"], boolean> & {
  /** When "QR codes printed" was ticked; null while it isn't. */
  qrCodesPrintedAt: Date | null;
};

/**
 * Every restaurant's onboarding checklist, by restaurant id. Admin only: the
 * function is the one place that reads across tenants, and tenants get nothing
 * on the table behind the manual tick. Everything but "QR codes printed" is
 * derived from the restaurant's data.
 */
export async function onboardingChecklists(admin: Admin) {
  const { rows } = await getAdminDb().execute<{
    restaurant_id: string;
    menu_entered: boolean;
    photos: boolean;
    exchange_rate_set: boolean;
    tables_added: boolean;
    qr_codes_printed: boolean;
    qr_codes_printed_at: string | null;
    booking_hours_set: boolean;
    booking_enabled: boolean;
  }>(sql`select * from platform_onboarding_checklist(${admin.platformAdminId})`);
  return new Map<string, OnboardingChecklist>(
    rows.map((row) => [
      row.restaurant_id,
      {
        menuEntered: row.menu_entered,
        photos: row.photos,
        exchangeRateSet: row.exchange_rate_set,
        tablesAdded: row.tables_added,
        qrCodesPrinted: row.qr_codes_printed,
        qrCodesPrintedAt: row.qr_codes_printed_at ? new Date(row.qr_codes_printed_at) : null,
        bookingHoursSet: row.booking_hours_set,
        bookingEnabled: row.booking_enabled,
      },
    ]),
  );
}

/**
 * Ticks or unticks "QR codes printed", the one item nothing in the database can
 * show, and audits the change. The restaurant id is the admin's choice of
 * tenant, as for entering one.
 */
export async function setQrCodesPrinted(
  admin: Admin,
  restaurantId: string,
  printed: boolean,
): Promise<{ problem: "no_restaurant" } | { problem?: undefined }> {
  try {
    await getAdminDb().execute(
      sql`select platform_set_qr_codes_printed(${admin.platformAdminId}, ${restaurantId}, ${printed})`,
    );
    return {};
  } catch (error) {
    const { code } = (error as { cause?: { code?: string } }).cause ?? {};
    if (code === NO_DATA_FOUND) return { problem: "no_restaurant" };
    throw error;
  }
}
