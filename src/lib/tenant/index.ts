import "server-only";
import { cache } from "react";
import { and, eq } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { forbidden, redirect, unauthorized } from "next/navigation";
import { staff } from "@/db/schema";
import { type Audience, sessionOf } from "@/lib/auth";
import { findPlatformAdminId, findStaffIdentity } from "@/lib/auth/identity";
import { devAuthBypassEnabled } from "@/lib/env";
import { STAFF_PAGE_HEADER } from "@/lib/staff-page-header";
import { enteredRestaurant } from "./admin-entry";
import {
  defaultDevIdentity,
  DEV_IDENTITY_COOKIE,
  devPlatformAdmin,
  findDevIdentity,
} from "./dev-identities";
import { type TenantContext, withTenant } from "./scope";

/**
 * The tenant seam (S-25): who is asking. Everything that touches tenant data
 * goes through it or through ./scope, which holds withTenant: ESLint keeps getDb
 * out of the rest of the app. This file loads sign-in, so code on a public route
 * imports ./scope and ./public instead (S-32).
 */

export { type TenantContext, type TenantTransaction, withTenant } from "./scope";

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
 * A platform admin outside any restaurant has no tenant, so a data request gets
 * a 403. A page someone navigated to (Back after Leave, an old bookmark) goes
 * to /admin instead, where they can pick a restaurant. The proxy marks a GET of a
 * staff page, a browser load or the app router's own fetch, and nothing else: a
 * form posted to a route is a navigation too, but not a page. Nor is a server action.
 */
async function noTenantForAdmin(): Promise<never> {
  const page = await (async () => {
    const requestHeaders = await headers();
    return requestHeaders.get(STAFF_PAGE_HEADER) === "1" && !requestHeaders.get("next-action");
    // No request to read (a script or a test): the plain 403.
  })().catch(() => false);
  if (page) redirect("/admin");
  forbidden();
}

/**
 * Who the real session says this is. findStaffIdentity runs on every request,
 * not just at sign-in, so deactivating someone logs them out on their next one.
 * Entering a restaurant is a deliberate act, so it wins over a staff session in
 * the same browser. A platform admin who hasn't entered one has no tenant, so
 * gets the 403 the dev bypass gives them rather than being told they're signed
 * out. On a page they go to /admin (noTenantForAdmin).
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
  if (!member && admin) return noTenantForAdmin();
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
 * entering a restaurant (on a page, /admin instead). Once inside, they get its
 * shadow staff row, as an owner.
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
    if (!entered) return noTenantForAdmin();
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

/**
 * Whose live session of this type the browser has, for the sign-in pages: the
 * same checks as a request, so a deactivated person gets the form. The dev
 * bypass isn't a session, and under it the form still shows.
 */
export async function signedInEmail(audience: Audience): Promise<string | undefined> {
  if (devAuthBypassEnabled()) return undefined;
  const session = await sessionOf(audience, await headers());
  if (!session) return undefined;
  const known =
    audience === "staff"
      ? await findStaffIdentity(session.email)
      : await findPlatformAdminId(session.email);
  return known ? session.email : undefined;
}

/**
 * Where whoever is asking belongs, or undefined when signed out. Only for
 * offering a link: it guards nothing, and the page it names checks for itself.
 */
export async function signedInHome(): Promise<"/dashboard" | "/admin" | undefined> {
  if (devAuthBypassEnabled()) {
    const identity = await currentIdentity();
    if (!identity) return undefined;
    if (!("platformAdminId" in identity)) return "/dashboard";
    return (await enteredContext(identity)) ? "/dashboard" : "/admin";
  }
  if (await signedInEmail("staff")) return "/dashboard";
  const admin = await sessionPlatformAdmin(await headers());
  if (!admin) return undefined;
  return (await enteredContext(admin)) ? "/dashboard" : "/admin";
}

/** Guards owner-only actions (S-26). RLS is tenant-only, so roles live here. */
export function requireOwner(ctx: TenantContext) {
  if (ctx.role !== "owner") forbidden();
}
