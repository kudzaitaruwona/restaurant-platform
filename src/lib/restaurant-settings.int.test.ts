import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { restaurants } from "@/db/schema";
import {
  openOwnerDatabase,
  testDatabaseSettings,
} from "../../test/integration/database";
import {
  getRestaurantSettings,
  updateRestaurantSettings,
} from "./restaurant-settings";

const owner = openOwnerDatabase();

async function newRestaurant() {
  const id = crypto.randomUUID();
  await owner.db.insert(restaurants).values({
    id,
    name: "Before",
    slug: `settings-${id}`,
    menuToken: id,
    currencyMode: "usd_only",
  });
  return id;
}

const changes = {
  name: "After",
  contactPhone: "+263771234567",
  wifiName: "Guest",
  wifiPassword: "sadza",
  currencyMode: "both",
  timezone: "Africa/Johannesburg",
} as const;

beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});
afterAll(async () => {
  await owner.db.delete(restaurants).where(sql`slug like 'settings-%'`);
  await owner.pool.end();
  vi.unstubAllEnvs();
});

describe("restaurant settings", () => {
  it("saves every setting for the restaurant in the context and no other", async () => {
    const [mine, theirs] = [await newRestaurant(), await newRestaurant()];

    await updateRestaurantSettings({ restaurantId: mine }, changes);

    expect(await getRestaurantSettings({ restaurantId: mine })).toEqual(changes);
    expect(await getRestaurantSettings({ restaurantId: theirs })).toMatchObject({
      name: "Before",
      contactPhone: null,
    });
  });

  it("leaves the public identifiers alone", async () => {
    const id = await newRestaurant();

    await updateRestaurantSettings({ restaurantId: id }, changes);

    const [row] = await owner.db.select().from(restaurants).where(eq(restaurants.id, id));
    expect(row).toMatchObject({ slug: `settings-${id}`, menuToken: id });
  });
});

describe("the database's own check on contact_phone", () => {
  it.each(["0771234567", "263771234567", "+0771234567", "+1234567890123456", "+ 263"])(
    "refuses %j, whoever writes it",
    async (phone) => {
      const id = await newRestaurant();

      await expect(
        owner.db.update(restaurants).set({ contactPhone: phone }).where(eq(restaurants.id, id)),
      ).rejects.toMatchObject({ cause: { constraint: "restaurants_contact_phone_e164" } });
    },
  );

  it("takes E.164 or nothing", async () => {
    const id = await newRestaurant();
    for (const phone of ["+263771234567", null]) {
      await owner.db.update(restaurants).set({ contactPhone: phone }).where(eq(restaurants.id, id));
    }
  });
});
