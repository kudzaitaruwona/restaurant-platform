import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { openTestDatabase } from "../../test/integration/database";

const { db, pool } = openTestDatabase();
afterAll(() => pool.end());

describe("migrations", () => {
  it("enable btree_gist, which the booking and service-period exclusion constraints need", async () => {
    const { rows } = await db.execute(
      sql`select extname from pg_extension where extname = 'btree_gist'`,
    );
    expect(rows).toEqual([{ extname: "btree_gist" }]);
  });
});
