import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  openOwnerDatabase,
  openTestDatabase,
} from "../../test/integration/database";
import { categories, menuItems, restaurants, specials } from "./schema";

/**
 * What Postgres itself guarantees about specials, whatever the app does: the
 * price checks and D-05's exclusion constraint. Mostly as the owner role, which
 * RLS skips, so a refusal here comes from the constraint and not from a policy.
 */
const app = openTestDatabase();
const owner = openOwnerDatabase();

const SLUG_PREFIX = "specials-";
const CHECK_VIOLATION = "23514";
const FOREIGN_KEY_VIOLATION = "23503";
const EXCLUSION_VIOLATION = "23P01";

async function newRestaurant() {
  const id = crypto.randomUUID();
  await owner.db.insert(restaurants).values({
    id,
    name: "Specials",
    slug: `${SLUG_PREFIX}${id}`,
    menuToken: id,
    currencyMode: "usd_only",
  });
  const [category] = await owner.db
    .insert(categories)
    .values({ restaurantId: id, name: "Mains" })
    .returning({ id: categories.id });
  const [item] = await owner.db
    .insert(menuItems)
    .values({ restaurantId: id, categoryId: category.id, name: "Stew", priceUsd: "8" })
    .returning({ id: menuItems.id });
  const [other] = await owner.db
    .insert(menuItems)
    .values({ restaurantId: id, categoryId: category.id, name: "Pie", priceUsd: "5" })
    .returning({ id: menuItems.id });
  return { restaurantId: id, itemId: item.id, otherItemId: other.id };
}

let mine: Awaited<ReturnType<typeof newRestaurant>>;
let theirs: Awaited<ReturnType<typeof newRestaurant>>;

beforeAll(async () => {
  [mine, theirs] = [await newRestaurant(), await newRestaurant()];
});

afterAll(async () => {
  for (const { restaurantId } of [mine, theirs]) {
    await owner.db.delete(specials).where(eq(specials.restaurantId, restaurantId));
    await owner.db.delete(menuItems).where(eq(menuItems.restaurantId, restaurantId));
    await owner.db.delete(categories).where(eq(categories.restaurantId, restaurantId));
    await owner.db.delete(restaurants).where(eq(restaurants.id, restaurantId));
  }
  await Promise.all([app.pool.end(), owner.pool.end()]);
});

const at = (iso: string) => new Date(iso);

const special = (
  fields: Partial<typeof specials.$inferInsert> = {},
  who: { restaurantId: string; itemId: string } = mine,
) => ({
  restaurantId: who.restaurantId,
  menuItemId: who.itemId,
  title: "Taco Tuesday",
  ...fields,
});

beforeEach(async () => {
  for (const { restaurantId } of [mine, theirs]) {
    await owner.db.delete(specials).where(eq(specials.restaurantId, restaurantId));
  }
});

describe("special prices", () => {
  it.each([
    ["a USD price", { specialPriceUsd: "6" }],
    ["a ZiG price", { specialPriceZig: "150" }],
    ["both", { specialPriceUsd: "6", specialPriceZig: "150" }],
    ["a badge alone", { title: "Chef's pick" }],
    ["a free special", { specialPriceUsd: "0" }],
  ])("takes %s", async (_name, fields) => {
    await expect(
      owner.db.insert(specials).values(special({ title: null, ...fields })),
    ).resolves.toBeDefined();
  });

  it.each([
    ["USD", { specialPriceUsd: "-0.01" }],
    ["ZiG", { specialPriceZig: "-1" }],
  ])("refuses a negative %s price", async (_name, fields) => {
    await expect(
      owner.db.insert(specials).values(special(fields)),
    ).rejects.toMatchObject({ cause: { code: CHECK_VIOLATION } });
  });

  it.each([
    ["a USD price of NaN", { specialPriceUsd: "NaN" }],
    ["a ZiG price of NaN", { specialPriceZig: "NaN" }],
    ["a USD price of Infinity", { specialPriceUsd: "Infinity" }],
    ["a ZiG price of Infinity", { specialPriceZig: "Infinity" }],
    ["a USD price of -Infinity", { specialPriceUsd: "-Infinity" }],
    ["NaN beside a real price", { specialPriceUsd: "6", specialPriceZig: "NaN" }],
  ])("refuses %s, which numeric would otherwise store", async (_name, fields) => {
    await expect(
      owner.db.insert(specials).values(special(fields)),
    ).rejects.toMatchObject({ cause: { code: CHECK_VIOLATION } });
  });

  it("refuses a special with no title and no price: it would change nothing", async () => {
    await expect(
      owner.db.insert(specials).values(special({ title: null })),
    ).rejects.toMatchObject({ cause: { code: CHECK_VIOLATION } });
  });
});

describe("the window", () => {
  it("refuses an end that is not after the start", async () => {
    for (const endsAt of [at("2030-01-01T00:00:00Z"), at("2029-12-31T00:00:00Z")]) {
      await expect(
        owner.db
          .insert(specials)
          .values(special({ startsAt: at("2030-01-01T00:00:00Z"), endsAt })),
      ).rejects.toMatchObject({ cause: { code: CHECK_VIOLATION } });
    }
  });

  it("keeps D-04's recurring columns, which nothing reads yet", async () => {
    const [row] = await owner.db
      .insert(specials)
      .values(special({ daysOfWeek: [2], dailyStart: "17:00", dailyEnd: "21:00" }))
      .returning();
    expect(row).toMatchObject({ daysOfWeek: [2], dailyStart: "17:00:00", dailyEnd: "21:00:00" });
  });
});

describe("D-05: no two active specials overlap on one item", () => {
  const first = { startsAt: at("2030-03-01T00:00:00Z"), endsAt: at("2030-03-08T00:00:00Z") };

  const insertRefused = (fields: Partial<typeof specials.$inferInsert>, who = mine) =>
    expect(
      owner.db.insert(specials).values(special(fields, who)),
    ).rejects.toMatchObject({ cause: { code: EXCLUSION_VIOLATION } });

  it("refuses a second special whose dates overlap", async () => {
    await owner.db.insert(specials).values(special(first));

    await insertRefused({ startsAt: at("2030-03-07T23:59:59Z"), endsAt: at("2030-03-10T00:00:00Z") });
    await insertRefused({ startsAt: at("2030-02-20T00:00:00Z"), endsAt: at("2030-03-02T00:00:00Z") });
    await insertRefused({ startsAt: at("2030-03-02T00:00:00Z"), endsAt: at("2030-03-03T00:00:00Z") });
    await insertRefused(first);
  });

  it("takes one that starts exactly when the first ends, and the one before", async () => {
    await owner.db.insert(specials).values(special(first));

    await expect(
      owner.db.insert(specials).values(
        special({ startsAt: first.endsAt, endsAt: at("2030-03-15T00:00:00Z") }),
      ),
    ).resolves.toBeDefined();
    await expect(
      owner.db.insert(specials).values(
        special({ startsAt: at("2030-02-22T00:00:00Z"), endsAt: first.startsAt }),
      ),
    ).resolves.toBeDefined();
  });

  it("reads no end date as until turned off", async () => {
    await owner.db.insert(specials).values(special({ startsAt: first.startsAt, endsAt: null }));

    await insertRefused({ startsAt: at("2040-01-01T00:00:00Z"), endsAt: at("2040-01-02T00:00:00Z") });
    await insertRefused({ startsAt: null, endsAt: null });
    await expect(
      owner.db.insert(specials).values(
        special({ startsAt: at("2030-01-01T00:00:00Z"), endsAt: first.startsAt }),
      ),
    ).resolves.toBeDefined();
  });

  it("reads no start date as from the beginning", async () => {
    await owner.db.insert(specials).values(special({ startsAt: null, endsAt: first.endsAt }));

    await insertRefused({ startsAt: at("2020-01-01T00:00:00Z"), endsAt: at("2020-01-02T00:00:00Z") });
    await expect(
      owner.db.insert(specials).values(
        special({ startsAt: first.endsAt, endsAt: null }),
      ),
    ).resolves.toBeDefined();
  });

  it("ignores a special that is turned off, and checks again when it is turned on", async () => {
    const [off] = await owner.db
      .insert(specials)
      .values(special({ ...first, active: false }))
      .returning({ id: specials.id });

    await owner.db.insert(specials).values(special(first));

    await expect(
      owner.db.update(specials).set({ active: true }).where(eq(specials.id, off.id)),
    ).rejects.toMatchObject({ cause: { code: EXCLUSION_VIOLATION } });
  });

  it("lets the same dates stand once the first is turned off", async () => {
    const [on] = await owner.db
      .insert(specials)
      .values(special(first))
      .returning({ id: specials.id });
    await owner.db.update(specials).set({ active: false }).where(eq(specials.id, on.id));

    await expect(owner.db.insert(specials).values(special(first))).resolves.toBeDefined();
  });

  it("refuses a move into an overlap too", async () => {
    await owner.db.insert(specials).values(special(first));
    const [later] = await owner.db
      .insert(specials)
      .values(special({ startsAt: at("2030-04-01T00:00:00Z"), endsAt: at("2030-04-02T00:00:00Z") }))
      .returning({ id: specials.id });

    await expect(
      owner.db
        .update(specials)
        .set({ startsAt: at("2030-03-05T00:00:00Z") })
        .where(eq(specials.id, later.id)),
    ).rejects.toMatchObject({ cause: { code: EXCLUSION_VIOLATION } });
  });

  it("is per item: another item can run the same dates", async () => {
    await owner.db.insert(specials).values(special(first));

    await expect(
      owner.db
        .insert(specials)
        .values(special(first, { restaurantId: mine.restaurantId, itemId: mine.otherItemId })),
    ).resolves.toBeDefined();
  });

  it("is per restaurant: another restaurant's item can run the same dates", async () => {
    await owner.db.insert(specials).values(special(first));

    await expect(
      owner.db.insert(specials).values(special(first, theirs)),
    ).resolves.toBeDefined();
  });

  it("is a rule of the table, not of the role: app_tenant meets it too", async () => {
    await owner.db.insert(specials).values(special(first));

    await expect(
      app.db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.restaurant_id', ${mine.restaurantId}, true)`);
        await tx.insert(specials).values(special(first));
      }),
    ).rejects.toMatchObject({ cause: { code: EXCLUSION_VIOLATION } });
  });
});

describe("the composite key to menu_items", () => {
  it("refuses a special in one restaurant on another restaurant's item", async () => {
    await expect(
      owner.db.insert(specials).values(special({}, { restaurantId: mine.restaurantId, itemId: theirs.itemId })),
    ).rejects.toMatchObject({ cause: { code: FOREIGN_KEY_VIOLATION } });
  });
});

describe("row level security", () => {
  it("shows a tenant its own specials only", async () => {
    await owner.db.insert(specials).values([special({}, mine), special({}, theirs)]);

    const seen = await app.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.restaurant_id', ${mine.restaurantId}, true)`);
      return tx.select({ restaurantId: specials.restaurantId }).from(specials);
    });

    expect(seen).toEqual([{ restaurantId: mine.restaurantId }]);
  });

  it("shows nothing outside a tenant", async () => {
    await owner.db.insert(specials).values(special());
    expect(await app.db.select().from(specials)).toEqual([]);
  });

  it("refuses a write into another tenant", async () => {
    await expect(
      app.db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.restaurant_id', ${mine.restaurantId}, true)`);
        await tx.insert(specials).values(special({}, theirs));
      }),
    ).rejects.toThrow();
  });
});
