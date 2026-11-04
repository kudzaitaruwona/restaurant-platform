import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  openOwnerDatabase,
  openTestDatabase,
} from "../../test/integration/database";
import { devRestaurants } from "../lib/tenant/dev-identities";

const app = openTestDatabase();
const owner = openOwnerDatabase();
afterAll(() => Promise.all([app.pool.end(), owner.pool.end()]));

const INSUFFICIENT_PRIVILEGE = "42501";
const [restaurantA, restaurantB] = devRestaurants.map((r) => r.id);

/** Runs `fn` as tenant `restaurantId` on one app-role transaction. */
async function asTenant<T>(
  restaurantId: string,
  fn: (tx: Parameters<Parameters<typeof app.db.transaction>[0]>[0]) => Promise<T>,
) {
  return app.db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.restaurant_id', ${restaurantId}, true)`);
    return fn(tx);
  });
}

const insertEntry = (restaurantId: string, action: string) => sql`
  insert into audit_log (restaurant_id, actor_type, action, entity_type, entity_id)
  values (${restaurantId}, 'system', ${action}, 'restaurant', gen_random_uuid())
`;

describe("platform_admins", () => {
  it("stores an email once, and the app role can't touch the table at all", async () => {
    const email = `admin-${crypto.randomUUID()}@example.test`;
    await owner.db.execute(sql`insert into platform_admins (email) values (${email})`);
    await expect(
      owner.db.execute(sql`insert into platform_admins (email) values (${email})`),
    ).rejects.toMatchObject({ cause: { code: "23505" } });

    for (const statement of [
      sql`select * from platform_admins`,
      sql`insert into platform_admins (email) values ('x@example.test')`,
      sql`update platform_admins set email = 'y@example.test'`,
      sql`delete from platform_admins`,
    ]) {
      await expect(app.db.execute(statement)).rejects.toMatchObject({
        cause: { code: INSUFFICIENT_PRIVILEGE },
      });
    }
  });
});

describe("audit_log", () => {
  it("lets a tenant append and read its own entries", async () => {
    const action = `test.own.${crypto.randomUUID()}`;
    const rows = await asTenant(restaurantA, async (tx) => {
      await tx.execute(insertEntry(restaurantA, action));
      const { rows } = await tx.execute(
        sql`select actor_type, actor_id, details from audit_log where action = ${action}`,
      );
      return rows;
    });
    expect(rows).toEqual([{ actor_type: "system", actor_id: null, details: {} }]);
  });

  it("hides other tenants' entries and rejects writing into another tenant", async () => {
    const action = `test.other.${crypto.randomUUID()}`;
    await owner.db.execute(insertEntry(restaurantB, action));

    const seen = await asTenant(restaurantA, async (tx) => {
      const { rows } = await tx.execute(
        sql`select 1 from audit_log where action = ${action}`,
      );
      return rows;
    });
    expect(seen).toEqual([]);

    await expect(
      asTenant(restaurantA, (tx) => tx.execute(insertEntry(restaurantB, "test.cross"))),
    ).rejects.toMatchObject({ cause: { code: INSUFFICIENT_PRIVILEGE } });
  });

  it("is append-only for the app role: no update, no delete", async () => {
    for (const statement of [
      sql`update audit_log set action = 'tampered'`,
      sql`delete from audit_log`,
    ]) {
      await expect(
        asTenant(restaurantA, (tx) => tx.execute(statement)),
      ).rejects.toMatchObject({ cause: { code: INSUFFICIENT_PRIVILEGE } });
    }
  });

  it("rejects an actor type outside staff, platform_admin and system", async () => {
    await expect(
      asTenant(restaurantA, (tx) =>
        tx.execute(sql`
          insert into audit_log (restaurant_id, actor_type, action, entity_type, entity_id)
          values (${restaurantA}, 'robot', 'x', 'x', gen_random_uuid())
        `),
      ),
    ).rejects.toMatchObject({ cause: { code: "22P02" } });
  });
});
