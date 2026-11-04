import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  openOwnerDatabase,
  openTestDatabase,
} from "../../test/integration/database";
import { categories, menuItems, restaurants } from "./schema";

/**
 * What Postgres itself guarantees about the menu, whatever the app does. Most of
 * this runs as the owner role, which RLS skips, so a refusal here comes from the
 * constraint and not from a policy.
 */
const app = openTestDatabase();
const owner = openOwnerDatabase();

const SLUG_PREFIX = "menu-tables-";
const CHECK_VIOLATION = "23514";
const FOREIGN_KEY_VIOLATION = "23503";
const UNIQUE_VIOLATION = "23505";

async function newRestaurant() {
  const id = crypto.randomUUID();
  await owner.db.insert(restaurants).values({
    id,
    name: "Menu tables",
    slug: `${SLUG_PREFIX}${id}`,
    menuToken: id,
    currencyMode: "usd_only",
  });
  const [category] = await owner.db
    .insert(categories)
    .values({ restaurantId: id, name: "Mains" })
    .returning({ id: categories.id });
  return { restaurantId: id, categoryId: category.id };
}

let mine: Awaited<ReturnType<typeof newRestaurant>>;
let theirs: Awaited<ReturnType<typeof newRestaurant>>;

beforeAll(async () => {
  [mine, theirs] = [await newRestaurant(), await newRestaurant()];
});

afterAll(async () => {
  for (const { restaurantId } of [mine, theirs]) {
    await owner.db.delete(menuItems).where(eq(menuItems.restaurantId, restaurantId));
    await owner.db.delete(categories).where(eq(categories.restaurantId, restaurantId));
    await owner.db.delete(restaurants).where(eq(restaurants.id, restaurantId));
  }
  await Promise.all([app.pool.end(), owner.pool.end()]);
});

const item = (prices: { priceUsd?: string | null; priceZig?: string | null }) => ({
  ...mine,
  name: "Sadza",
  description: "",
  ...prices,
});

describe("menu item prices", () => {
  it("refuses an item with neither a USD nor a ZiG price", async () => {
    await expect(
      owner.db.insert(menuItems).values(item({})),
    ).rejects.toMatchObject({ cause: { code: CHECK_VIOLATION } });
  });

  it("refuses an update that clears the last price", async () => {
    const [{ id }] = await owner.db
      .insert(menuItems)
      .values(item({ priceUsd: "8.00" }))
      .returning({ id: menuItems.id });

    await expect(
      owner.db.update(menuItems).set({ priceUsd: null }).where(eq(menuItems.id, id)),
    ).rejects.toMatchObject({ cause: { code: CHECK_VIOLATION } });
  });

  it.each([
    ["USD alone", { priceUsd: "8.00" }],
    ["ZiG alone", { priceZig: "210" }],
    ["both", { priceUsd: "8.00", priceZig: "210" }],
    ["free", { priceUsd: "0" }],
  ])("takes %s", async (_name, prices) => {
    await expect(
      owner.db.insert(menuItems).values(item(prices)),
    ).resolves.toBeDefined();
  });

  it.each([
    ["USD", { priceUsd: "-0.01" }],
    ["ZiG", { priceZig: "-1" }],
  ])("refuses a negative %s price", async (_name, prices) => {
    await expect(
      owner.db.insert(menuItems).values(item(prices)),
    ).rejects.toMatchObject({ cause: { code: CHECK_VIOLATION } });
  });
});

describe("the composite key from menu_items to categories", () => {
  it("refuses an item in one restaurant under another restaurant's category", async () => {
    await expect(
      owner.db
        .insert(menuItems)
        .values({ ...item({ priceUsd: "8.00" }), categoryId: theirs.categoryId }),
    ).rejects.toMatchObject({ cause: { code: FOREIGN_KEY_VIOLATION } });
  });

  it("refuses moving an item onto another restaurant's category", async () => {
    const [{ id }] = await owner.db
      .insert(menuItems)
      .values(item({ priceUsd: "8.00" }))
      .returning({ id: menuItems.id });

    await expect(
      owner.db
        .update(menuItems)
        .set({ categoryId: theirs.categoryId })
        .where(eq(menuItems.id, id)),
    ).rejects.toMatchObject({ cause: { code: FOREIGN_KEY_VIOLATION } });
  });
});

describe("restaurants.menu_token", () => {
  it("is unique: a second restaurant can't take one already in use", async () => {
    const id = crypto.randomUUID();
    await expect(
      owner.db.insert(restaurants).values({
        id,
        name: "Copycat",
        slug: `${SLUG_PREFIX}${id}`,
        menuToken: mine.restaurantId,
        currencyMode: "usd_only",
      }),
    ).rejects.toMatchObject({ cause: { code: UNIQUE_VIOLATION } });
  });

  it("is required", async () => {
    await expect(
      owner.db.execute(
        sql`update restaurants set menu_token = null where id = ${mine.restaurantId}`,
      ),
    ).rejects.toMatchObject({ cause: { code: "23502" } });
  });
});

describe("outside any tenant", () => {
  it.each(["categories", "menu_items"])(
    "the app role sees no rows in %s, though the table has rows",
    async (table) => {
      const count = async (database: typeof app.db) => {
        const { rows } = await database.execute(
          sql`select count(*)::int as count from ${sql.identifier(table)}`,
        );
        return rows[0].count;
      };
      expect(await count(owner.db)).toBeGreaterThan(0);
      expect(await count(app.db)).toBe(0);
    },
  );
});
