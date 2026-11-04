import {
  devIdentities,
  devPlatformAdmin,
  devRestaurants,
} from "../lib/tenant/dev-identities";
import type { Database } from "./client";
import {
  adminAuthSession,
  adminAuthUser,
  platformAdmins,
  restaurants,
  staff,
} from "./schema";

/**
 * Restaurants A and B, each with one owner and one staff member, and the
 * platform admin with the session the bypass stands on. Needs the role that owns
 * the tables: the app role can't create restaurants or touch platform_admins.
 * Safe to re-run.
 */
export async function seedDevData(db: Database) {
  await db
    .insert(restaurants)
    .values(
      devRestaurants.map((restaurant) => ({
        ...restaurant,
        menuToken: `dev-menu-${restaurant.slug}`,
        currencyMode: "usd_primary" as const,
      })),
    )
    .onConflictDoNothing();

  await db
    .insert(staff)
    .values(
      devIdentities.map(({ key, label, restaurantId, staffId, role }) => ({
        id: staffId,
        restaurantId,
        email: `${key}@dev.example.test`,
        displayName: label,
        role,
      })),
    )
    .onConflictDoNothing();

  await db
    .insert(platformAdmins)
    .values({
      id: devPlatformAdmin.platformAdminId,
      email: devPlatformAdmin.email,
    })
    .onConflictDoNothing();

  // Never a way in: no cookie can carry it, because a cookie is signed with
  // AUTH_SECRET. Its own email, so a real sign-in as the admin stays separate.
  const { sessionId } = devPlatformAdmin;
  await db
    .insert(adminAuthUser)
    .values({
      id: sessionId,
      name: "",
      email: `${sessionId}@dev.example.test`,
      emailVerified: true,
    })
    .onConflictDoNothing();
  await db
    .insert(adminAuthSession)
    .values({
      id: sessionId,
      token: sessionId,
      userId: sessionId,
      expiresAt: new Date("2100-01-01T00:00:00Z"),
    })
    .onConflictDoNothing();
}
