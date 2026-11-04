import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { openTestDatabase } from "../../test/integration/database";

const { db, pool } = openTestDatabase();
afterAll(() => pool.end());

describe("database client (Neon WebSocket Pool driver)", () => {
  it("runs queries against Postgres", async () => {
    const { rows } = await db.execute(sql`select 1 + 1 as two`);
    expect(rows).toEqual([{ two: 2 }]);
  });

  it("supports interactive transactions with transaction-local settings (D-07)", async () => {
    const inside = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.restaurant_id', 'example', true)`,
      );
      const { rows } = await tx.execute(
        sql`select current_setting('app.restaurant_id', true) as value`,
      );
      return rows[0].value;
    });
    expect(inside).toBe("example");

    const { rows } = await db.execute(
      sql`select coalesce(current_setting('app.restaurant_id', true), '') as value`,
    );
    expect(rows[0].value).toBe("");
  });

  it("supports savepoints: a failed nested transaction rolls back alone", async () => {
    const result = await db.transaction(async (tx) => {
      await expect(
        tx.transaction(async (nested) => {
          await nested.execute(sql`select 1 / 0`);
        }),
      ).rejects.toMatchObject({ cause: { code: "22012" } }); // division_by_zero
      const { rows } = await tx.execute(sql`select 'still usable' as value`);
      return rows[0].value;
    });
    expect(result).toBe("still usable");
  });
});
