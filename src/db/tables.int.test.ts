import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  openOwnerDatabase,
  openTestDatabase,
} from "../../test/integration/database";
import { diningTables, restaurants } from "./schema";

/**
 * What Postgres itself guarantees about tables, whatever the app does. Most of
 * this runs as the owner role, which RLS skips, so a refusal here comes from the
 * constraint and not from a policy.
 */
const app = openTestDatabase();
const owner = openOwnerDatabase();

const SLUG_PREFIX = "tables-";
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";

const token = () => crypto.randomUUID().replaceAll("-", "").slice(0, 22).padEnd(22, "x");

async function newRestaurant() {
  const id = crypto.randomUUID();
  await owner.db.insert(restaurants).values({
    id,
    name: "Tables",
    slug: `${SLUG_PREFIX}${id}`,
    menuToken: id,
    currencyMode: "usd_only",
  });
  return id;
}

let mine: string;
let theirs: string;

beforeAll(async () => {
  [mine, theirs] = [await newRestaurant(), await newRestaurant()];
});

afterAll(async () => {
  for (const id of [mine, theirs]) {
    await owner.db.delete(diningTables).where(eq(diningTables.restaurantId, id));
    await owner.db.delete(restaurants).where(eq(restaurants.id, id));
  }
  await Promise.all([app.pool.end(), owner.pool.end()]);
});

const table = (values: Partial<typeof diningTables.$inferInsert> = {}) => ({
  restaurantId: mine,
  label: crypto.randomUUID(),
  capacity: 4,
  qrToken: token(),
  ...values,
});

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: { cause?: { code?: string } }) => error.cause?.code,
  );

describe("capacity", () => {
  it.each([0, -1])("can't be %d", async (capacity) => {
    expect(await code(owner.db.insert(diningTables).values(table({ capacity })))).toBe(
      CHECK_VIOLATION,
    );
  });
});

describe("label", () => {
  it("is unique among a restaurant's live tables", async () => {
    const label = "Unique label";
    await owner.db.insert(diningTables).values(table({ label }));

    expect(await code(owner.db.insert(diningTables).values(table({ label })))).toBe(
      UNIQUE_VIOLATION,
    );
  });

  it("can be used again by another restaurant", async () => {
    const label = "Shared label";
    await owner.db.insert(diningTables).values(table({ label }));

    await owner.db.insert(diningTables).values(table({ label, restaurantId: theirs }));
  });

  it("is free again once the table is archived", async () => {
    const label = "Archived label";
    await owner.db
      .insert(diningTables)
      .values(table({ label, archivedAt: new Date() }));

    await owner.db.insert(diningTables).values(table({ label }));
    await owner.db.insert(diningTables).values(table({ label, archivedAt: new Date() }));
  });
});

describe("qr_token", () => {
  it("is unique across restaurants", async () => {
    const qrToken = token();
    await owner.db.insert(diningTables).values(table({ qrToken }));

    expect(
      await code(
        owner.db.insert(diningTables).values(table({ qrToken, restaurantId: theirs })),
      ),
    ).toBe(UNIQUE_VIOLATION);
  });

  it.each(["", "short", "a".repeat(21), `${"a".repeat(21)}-`, `${"a".repeat(21)} `])(
    "can't be %j: too short or not base62",
    async (qrToken) => {
      expect(await code(owner.db.insert(diningTables).values(table({ qrToken })))).toBe(
        CHECK_VIOLATION,
      );
    },
  );
});

describe("the token lookup", () => {
  const lookup = (qrToken: string) =>
    app.db.execute<{ id: string | null }>(
      sql`select restaurant_id_by_table_token(${qrToken}) as id`,
    );

  it("names the restaurant of a live table's token, to a role that can see no tenant", async () => {
    const qrToken = token();
    await owner.db.insert(diningTables).values(table({ qrToken, restaurantId: theirs }));

    expect((await lookup(qrToken)).rows).toEqual([{ id: theirs }]);
  });

  it("names nothing for an archived table, an unknown token or a pattern", async () => {
    const qrToken = token();
    await owner.db.insert(diningTables).values(table({ qrToken, archivedAt: new Date() }));

    for (const missing of [qrToken, token(), "%", "' or 1=1 --"]) {
      expect((await lookup(missing)).rows).toEqual([{ id: null }]);
    }
  });
});

describe("row level security", () => {
  it("shows the app role no table outside a tenant", async () => {
    await owner.db.insert(diningTables).values(table());
    const { rows } = await app.db.execute(sql`select id from tables`);
    expect(rows).toEqual([]);
  });

  it("shows a tenant its own tables and refuses to write another's", async () => {
    await owner.db.insert(diningTables).values(table({ restaurantId: theirs }));

    const result = await app.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.restaurant_id', ${mine}, true)`);
      const { rows } = await tx.execute<{ restaurant_id: string }>(
        sql`select restaurant_id from tables`,
      );
      const write = await code(
        tx.insert(diningTables).values(table({ restaurantId: theirs })),
      );
      return { restaurants: new Set(rows.map((row) => row.restaurant_id)), write };
    });

    expect([...result.restaurants]).toEqual([mine]);
    expect(result.write).toBe("42501");
  });
});
