import { devIdentities, devRestaurants } from "../lib/tenant/dev-identities";
import type { Database } from "./client";
import { restaurants, staff } from "./schema";

/**
 * Restaurants A and B, each with one owner and one staff member. Needs the role
 * that owns the tables: the app role can't create restaurants. Safe to re-run.
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
}
