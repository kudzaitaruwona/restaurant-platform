import {
  devIdentities,
  devPlatformAdmin,
  devRestaurants,
} from "../lib/tenant/dev-identities";
import type { Database } from "./client";
import { platformAdmins, restaurants, staff } from "./schema";

/**
 * Restaurants A and B, each with one owner and one staff member, and the
 * platform admin. Needs the role that owns the tables: the app role can't create
 * restaurants or touch platform_admins. Safe to re-run.
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
}
