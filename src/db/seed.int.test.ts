import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { openOwnerDatabase } from "../../test/integration/database";
import {
  devIdentities,
  devPlatformAdmin,
  devRestaurants,
} from "../lib/tenant/dev-identities";
import { platformAdmins, restaurants, staff } from "./schema";
import { seedDevData } from "./seed";

const { db, pool } = openOwnerDatabase();
afterAll(() => pool.end());

const seededStaff = () =>
  db
    .select({ restaurantId: staff.restaurantId, role: staff.role })
    .from(staff)
    .where(
      inArray(
        staff.id,
        devIdentities.map((identity) => identity.staffId),
      ),
    );

describe("the development seed", () => {
  it("creates two restaurants, each with one owner and one staff member, and can re-run", async () => {
    await seedDevData(db);

    const seeded = await db
      .select({ id: restaurants.id })
      .from(restaurants)
      .where(
        inArray(
          restaurants.id,
          devRestaurants.map((restaurant) => restaurant.id),
        ),
      );
    expect(seeded).toHaveLength(2);

    const members = await seededStaff();
    for (const { id } of seeded) {
      const roles = members
        .filter((member) => member.restaurantId === id)
        .map((member) => member.role)
        .sort();
      expect(roles).toEqual(["owner", "staff"]);
    }
  });

  it("creates the platform admin the dev switcher offers", async () => {
    await seedDevData(db);

    const admins = await db
      .select({ id: platformAdmins.id })
      .from(platformAdmins)
      .where(eq(platformAdmins.id, devPlatformAdmin.platformAdminId));
    expect(admins).toHaveLength(1);
  });
});
