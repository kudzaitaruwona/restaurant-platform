import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { restaurants } from "@/db/schema";
import {
  openOwnerDatabase,
  testDatabaseSettings,
} from "../../test/integration/database";
import {
  getRestaurantSettings,
  isTimeZone,
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

/**
 * Names Node's ICU takes that this server's Postgres doesn't, so a query using
 * one fails. Which names those are depends on both tzdata versions.
 */
const knownToNodeNotToPostgres = "Asia/Calcutta";

describe("the timezone on save", () => {
  const timezoneOf = async (id: string) => {
    const [row] = await owner.db.select().from(restaurants).where(eq(restaurants.id, id));
    return row.timezone;
  };

  it("has a test name that Node accepts and this Postgres lacks", async () => {
    const { rows } = await owner.db.execute(
      sql`select 1 from pg_timezone_names where name = ${knownToNodeNotToPostgres}`,
    );
    expect(rows).toEqual([]);
    expect(isTimeZone(knownToNodeNotToPostgres)).toBe(true);
  });

  it("saves a changed zone that both know", async () => {
    const id = await newRestaurant();

    const result = await updateRestaurantSettings({ restaurantId: id }, changes);

    expect(result).toBe("saved");
    expect(await timezoneOf(id)).toBe("Africa/Johannesburg");
  });

  // A name Postgres knows that Intl.supportedValuesOf may omit: the case isTimeZone
  // exists for. This only bites on a runtime whose list omits the name; on one that
  // lists it the test still passes. What it asserts is that Postgres knows the name
  // and isTimeZone accepts it.
  it("saves a change to Asia/Kolkata, which Postgres knows and the list may omit", async () => {
    const { rows } = await owner.db.execute(
      sql`select 1 from pg_timezone_names where name = 'Asia/Kolkata'`,
    );
    expect(rows).toHaveLength(1);
    expect(isTimeZone("Asia/Kolkata")).toBe(true);
    const id = await newRestaurant();

    const result = await updateRestaurantSettings(
      { restaurantId: id },
      { ...changes, timezone: "Asia/Kolkata" },
    );

    expect(result).toBe("saved");
    expect(await timezoneOf(id)).toBe("Asia/Kolkata");
  });

  it.each([
    ["Node accepts but Postgres lacks", knownToNodeNotToPostgres],
    ["Node refuses", "Mars/Olympus"],
  ])("refuses a changed zone that %s, and saves nothing", async (_, timezone) => {
    const id = await newRestaurant();

    const result = await updateRestaurantSettings(
      { restaurantId: id },
      { ...changes, timezone },
    );

    expect(result).toBe("invalid_timezone");
    expect(await getRestaurantSettings({ restaurantId: id })).toMatchObject({
      name: "Before",
      timezone: "Africa/Harare",
    });
  });

  it.each([
    ["Node accepts but Postgres lacks", knownToNodeNotToPostgres],
    ["Node refuses", "Mars/Olympus"],
  ])("still saves other edits when the stored zone is one that %s", async (_, stored) => {
    const id = await newRestaurant();
    await owner.db.update(restaurants).set({ timezone: stored }).where(eq(restaurants.id, id));

    const result = await updateRestaurantSettings(
      { restaurantId: id },
      { ...changes, timezone: stored },
    );

    expect(result).toBe("saved");
    expect(await getRestaurantSettings({ restaurantId: id })).toMatchObject({
      wifiName: "Guest",
      timezone: stored,
    });
  });

  it("checks a change away from such a zone like any other", async () => {
    const id = await newRestaurant();
    await owner.db
      .update(restaurants)
      .set({ timezone: "Mars/Olympus" })
      .where(eq(restaurants.id, id));

    expect(
      await updateRestaurantSettings({ restaurantId: id }, { ...changes, timezone: "Mars/Phobos" }),
    ).toBe("invalid_timezone");
    expect(await updateRestaurantSettings({ restaurantId: id }, changes)).toBe("saved");
    expect(await timezoneOf(id)).toBe("Africa/Johannesburg");
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
