import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  openOwnerDatabase,
  openTestDatabase,
} from "../../test/integration/database";
import { exchangeRates, restaurants, staff } from "./schema";

/**
 * What Postgres itself guarantees about the exchange rate and the rounding steps
 * that price with it, whatever the app does. Mostly as the owner role, which RLS
 * skips, so a refusal here comes from the constraint and not from a policy.
 */
const app = openTestDatabase();
const owner = openOwnerDatabase();

const CHECK_VIOLATION = "23514";
const FOREIGN_KEY_VIOLATION = "23503";

async function newRestaurant() {
  const restaurantId = crypto.randomUUID();
  const staffId = crypto.randomUUID();
  await owner.db.insert(restaurants).values({
    id: restaurantId,
    name: "Exchange rates",
    slug: `exchange-rates-${restaurantId}`,
    menuToken: restaurantId,
    currencyMode: "both",
  });
  await owner.db.insert(staff).values({
    id: staffId,
    restaurantId,
    email: `${staffId}@example.test`,
    displayName: "Rate setter",
    role: "owner",
  });
  return { restaurantId, staffId };
}

let mine: Awaited<ReturnType<typeof newRestaurant>>;
let theirs: Awaited<ReturnType<typeof newRestaurant>>;

beforeAll(async () => {
  [mine, theirs] = [await newRestaurant(), await newRestaurant()];
});

afterAll(async () => {
  for (const { restaurantId } of [mine, theirs]) {
    await owner.db.delete(exchangeRates).where(eq(exchangeRates.restaurantId, restaurantId));
    // The restaurants stay behind: one with an owner can't lose it (S-26).
  }
  await Promise.all([app.pool.end(), owner.pool.end()]);
});

const rate = (usdToZig: string) => ({
  restaurantId: mine.restaurantId,
  setBy: mine.staffId,
  usdToZig,
});

describe("exchange_rates.usd_to_zig", () => {
  it.each(["26.2", "0.000001", "1000000"])("takes %s", async (usdToZig) => {
    await expect(
      owner.db.insert(exchangeRates).values(rate(usdToZig)),
    ).resolves.toBeDefined();
  });

  it.each(["0", "-1", "-0.01", "NaN", "Infinity", "-Infinity"])(
    "refuses %s, which numeric would otherwise store",
    async (usdToZig) => {
      await expect(
        owner.db.insert(exchangeRates).values(rate(usdToZig)),
      ).rejects.toMatchObject({ cause: { code: CHECK_VIOLATION } });
    },
  );

  it("is required", async () => {
    await expect(
      owner.db.execute(
        sql`insert into exchange_rates (restaurant_id, set_by) values (${mine.restaurantId}, ${mine.staffId})`,
      ),
    ).rejects.toMatchObject({ cause: { code: "23502" } });
  });
});

describe("the composite key from exchange_rates to staff", () => {
  it("refuses a rate set by another restaurant's staff", async () => {
    await expect(
      owner.db
        .insert(exchangeRates)
        .values({ ...rate("26.2"), setBy: theirs.staffId }),
    ).rejects.toMatchObject({ cause: { code: FOREIGN_KEY_VIOLATION } });
  });
});

describe("restaurants' rounding steps", () => {
  const setSteps = (zig: string, usd: string) =>
    owner.db
      .update(restaurants)
      .set({ zigRoundingStep: zig, usdRoundingStep: usd })
      .where(eq(restaurants.id, mine.restaurantId));

  it("start at the defaults the effective-price formula expects", async () => {
    const [row] = await owner.db
      .select({ zig: restaurants.zigRoundingStep, usd: restaurants.usdRoundingStep })
      .from(restaurants)
      .where(eq(restaurants.id, mine.restaurantId));
    expect(row).toEqual({ zig: "10", usd: "0.01" });
  });

  it("take other positive steps", async () => {
    await expect(setSteps("50", "0.05")).resolves.toBeDefined();
    await setSteps("10", "0.01");
  });

  it.each([
    ["a ZiG step of 0", "0", "0.01"],
    ["a USD step of 0", "10", "0"],
    ["a negative ZiG step", "-10", "0.01"],
    ["a negative USD step", "10", "-0.01"],
    ["a ZiG step of NaN", "NaN", "0.01"],
    ["a USD step of NaN", "10", "NaN"],
    ["a ZiG step of Infinity", "Infinity", "0.01"],
    ["a USD step of -Infinity", "10", "-Infinity"],
  ])("refuse %s", async (_name, zig, usd) => {
    await expect(setSteps(zig, usd)).rejects.toMatchObject({
      cause: { code: CHECK_VIOLATION },
    });
  });
});

describe("outside any tenant", () => {
  it("the app role sees no rows, though the table has some", async () => {
    await owner.db.insert(exchangeRates).values(rate("26.2"));
    const count = async (database: typeof app.db) => {
      const { rows } = await database.execute(
        sql`select count(*)::int as count from exchange_rates`,
      );
      return rows[0].count;
    };
    expect(await count(owner.db)).toBeGreaterThan(0);
    expect(await count(app.db)).toBe(0);
  });
});
