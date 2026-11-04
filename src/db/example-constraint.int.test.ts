import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { openTestDatabase } from "../../test/integration/database";

/**
 * Example of the pattern later tickets use for rules that protect seats or
 * money: the rule is a database constraint, and the test proves Postgres
 * itself rejects the bad row (no app code in between).
 *
 * The fixture is a temporary table that lives only inside this test's
 * transaction (ON COMMIT DROP). It is not part of the schema.
 */
const { db, pool } = openTestDatabase();
afterAll(() => pool.end());

const EXCLUSION_VIOLATION = "23P01";

describe("example constraint test", () => {
  it("Postgres rejects an overlapping reservation of the same resource", async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        create temporary table example_fixture_reservation (
          resource_id int not null,
          during tstzrange not null,
          -- "resource_id WITH =" inside a GiST index needs btree_gist.
          exclude using gist (resource_id with =, during with &&)
        ) on commit drop
      `);

      const reserve = (resourceId: number, from: string, to: string) =>
        tx.execute(sql`
          insert into example_fixture_reservation (resource_id, during)
          values (${resourceId}, tstzrange(${from}::timestamptz, ${to}::timestamptz))
        `);

      await reserve(1, "2026-11-01 18:00+02", "2026-11-01 20:00+02");
      // Back-to-back is fine: ranges are half-open.
      await reserve(1, "2026-11-01 20:00+02", "2026-11-01 22:00+02");
      // The same time on another resource is fine.
      await reserve(2, "2026-11-01 19:00+02", "2026-11-01 21:00+02");

      // Overlapping on resource 1 is not. The savepoint keeps the outer
      // transaction usable after the rejection.
      await expect(
        tx.transaction((nested) =>
          nested.execute(sql`
            insert into example_fixture_reservation (resource_id, during)
            values (1, tstzrange('2026-11-01 19:00+02', '2026-11-01 21:00+02'))
          `),
        ),
      ).rejects.toMatchObject({ cause: { code: EXCLUSION_VIOLATION } });

      const { rows } = await tx.execute(
        sql`select count(*)::int as count from example_fixture_reservation`,
      );
      expect(rows[0].count).toBe(3);
    });
  });
});
