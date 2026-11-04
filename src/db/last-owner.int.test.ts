import type { PoolClient } from "@neondatabase/serverless";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  openOwnerDatabase,
  openTestDatabase,
} from "../../test/integration/database";

/**
 * S-26: every restaurant keeps at least one active owner, whatever writes to
 * staff. Fixtures get their own restaurants, because the rule forbids removing
 * a last owner and that includes test cleanup: these rows stay behind, under
 * random slugs.
 */
const app = openTestDatabase();
const owner = openOwnerDatabase();
afterAll(() => Promise.all([app.pool.end(), owner.pool.end()]));

const LAST_OWNER = { cause: { constraint: "staff_last_active_owner" } };

type Member = {
  kind?: "staff" | "platform_admin";
  role?: "owner" | "staff";
  active?: boolean;
};

async function addMember(restaurantId: string, member: Member = {}) {
  const id = crypto.randomUUID();
  const { kind = "staff", role = "owner", active = true } = member;
  const email = kind === "staff" ? `${id}@example.test` : null;
  await owner.db.execute(sql`
    insert into staff (id, restaurant_id, kind, email, display_name, role, active)
    values (${id}, ${restaurantId}, ${kind}, ${email}, 'Fixture', ${role}, ${active})
  `);
  return id;
}

async function newRestaurant() {
  const id = crypto.randomUUID();
  await owner.db.execute(sql`
    insert into restaurants (id, name, slug, menu_token, currency_mode)
    values (${id}, 'Fixture', ${`last-owner-${id}`}, ${id}, 'usd_only')
  `);
  return id;
}

/** A restaurant and its one real owner. */
async function restaurantWithOwner() {
  const restaurantId = await newRestaurant();
  return { restaurantId, ownerId: await addMember(restaurantId) };
}

/** Runs a statement as the app does: app_tenant, inside the tenant. */
const asTenant = (restaurantId: string, statement: ReturnType<typeof sql>) =>
  app.db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.restaurant_id', ${restaurantId}, true)`);
    return tx.execute(statement);
  });

const activeOwners = async (restaurantId: string) => {
  const { rows } = await owner.db.execute(sql`
    select count(*)::int as count from staff
    where restaurant_id = ${restaurantId}
      and role = 'owner' and active and kind = 'staff'
  `);
  return rows[0].count;
};

describe("the last active owner", () => {
  it.each([
    ["deactivated", (id: string) => sql`update staff set active = false where id = ${id}`],
    ["demoted", (id: string) => sql`update staff set role = 'staff' where id = ${id}`],
    ["deleted", (id: string) => sql`delete from staff where id = ${id}`],
  ])("can't be %s", async (_verb, statement) => {
    const { restaurantId, ownerId } = await restaurantWithOwner();

    await expect(asTenant(restaurantId, statement(ownerId))).rejects.toMatchObject(LAST_OWNER);
    expect(await activeOwners(restaurantId)).toBe(1);
  });

  it("can't be removed by the role that owns the tables either", async () => {
    const { ownerId } = await restaurantWithOwner();

    await expect(
      owner.db.execute(sql`update staff set active = false where id = ${ownerId}`),
    ).rejects.toMatchObject(LAST_OWNER);
    await expect(
      owner.db.execute(sql`delete from staff where id = ${ownerId}`),
    ).rejects.toMatchObject(LAST_OWNER);
  });

  it("can't be turned into a platform_admin row", async () => {
    const { ownerId } = await restaurantWithOwner();

    await expect(
      owner.db.execute(sql`update staff set kind = 'platform_admin', email = null where id = ${ownerId}`),
    ).rejects.toMatchObject(LAST_OWNER);
  });

  it("can't be moved to another restaurant", async () => {
    const { restaurantId, ownerId } = await restaurantWithOwner();
    const elsewhere = await newRestaurant();

    await expect(
      owner.db.execute(sql`update staff set restaurant_id = ${elsewhere} where id = ${ownerId}`),
    ).rejects.toMatchObject(LAST_OWNER);
    expect(await activeOwners(restaurantId)).toBe(1);
  });

  it("isn't saved by a platform_admin shadow row with role = owner", async () => {
    const { restaurantId, ownerId } = await restaurantWithOwner();
    await addMember(restaurantId, { kind: "platform_admin" });

    await expect(
      asTenant(restaurantId, sql`update staff set active = false where id = ${ownerId}`),
    ).rejects.toMatchObject(LAST_OWNER);
  });

  it("isn't saved by a deactivated owner", async () => {
    const { restaurantId, ownerId } = await restaurantWithOwner();
    await addMember(restaurantId, { active: false });

    await expect(
      asTenant(restaurantId, sql`update staff set role = 'staff' where id = ${ownerId}`),
    ).rejects.toMatchObject(LAST_OWNER);
  });

  it("can't go in one statement that removes every owner at once", async () => {
    const { restaurantId } = await restaurantWithOwner();
    await addMember(restaurantId);

    await expect(
      asTenant(restaurantId, sql`update staff set role = 'staff' where restaurant_id = ${restaurantId}`),
    ).rejects.toMatchObject(LAST_OWNER);
    await expect(
      asTenant(restaurantId, sql`delete from staff where restaurant_id = ${restaurantId}`),
    ).rejects.toMatchObject(LAST_OWNER);
    expect(await activeOwners(restaurantId)).toBe(2);
  });
});

describe("what the rule leaves alone", () => {
  it("lets one of two owners go, then holds the other", async () => {
    const { restaurantId, ownerId } = await restaurantWithOwner();
    const second = await addMember(restaurantId);

    await asTenant(restaurantId, sql`update staff set role = 'staff' where id = ${ownerId}`);

    expect(await activeOwners(restaurantId)).toBe(1);
    await expect(
      asTenant(restaurantId, sql`update staff set active = false where id = ${second}`),
    ).rejects.toMatchObject(LAST_OWNER);
  });

  it("hands ownership over in one statement", async () => {
    const { restaurantId, ownerId } = await restaurantWithOwner();
    const colleague = await addMember(restaurantId, { role: "staff" });

    await asTenant(
      restaurantId,
      sql`update staff
          set role = (case when id = ${ownerId}::uuid then 'staff' else 'owner' end)::staff_role
          where id in (${ownerId}, ${colleague})`,
    );

    expect(await activeOwners(restaurantId)).toBe(1);
  });

  it("lets a restaurant go from no owners to one", async () => {
    const restaurantId = await newRestaurant();

    await addMember(restaurantId);

    expect(await activeOwners(restaurantId)).toBe(1);
  });

  it("doesn't get in the way of a restaurant that has no owner yet", async () => {
    const restaurantId = await newRestaurant();
    const colleague = await addMember(restaurantId, { role: "staff" });
    const shadow = await addMember(restaurantId, { kind: "platform_admin" });

    await asTenant(restaurantId, sql`update staff set active = false where id = ${colleague}`);
    await asTenant(restaurantId, sql`delete from staff where id = ${shadow}`);
    await asTenant(restaurantId, sql`delete from staff where id = ${colleague}`);
  });

  it("leaves everything else about an owner editable", async () => {
    const { restaurantId, ownerId } = await restaurantWithOwner();

    await asTenant(restaurantId, sql`update staff set display_name = 'Renamed' where id = ${ownerId}`);
  });

  it("doesn't count a platform_admin shadow row leaving as an owner leaving", async () => {
    const { restaurantId } = await restaurantWithOwner();
    const shadow = await addMember(restaurantId, { kind: "platform_admin" });

    await asTenant(restaurantId, sql`delete from staff where id = ${shadow}`);

    expect(await activeOwners(restaurantId)).toBe(1);
  });
});

describe("two transactions racing for the last two owners", () => {
  async function begin(restaurantId: string, isolation: string) {
    const client = await app.pool.connect();
    await client.query(`begin isolation level ${isolation}`);
    await client.query(`select set_config('app.restaurant_id', $1, true)`, [restaurantId]);
    return client;
  }

  const backendPid = async (client: PoolClient) =>
    (await client.query("select pg_backend_pid() as pid")).rows[0].pid as number;

  const waitUntilBlocked = (pid: number) =>
    vi.waitFor(
      async () => {
        const { rows } = await owner.db.execute(
          sql`select wait_event_type from pg_stat_activity where pid = ${pid}`,
        );
        expect(rows[0].wait_event_type).toBe("Lock");
      },
      { timeout: 5_000, interval: 20 },
    );

  /**
   * The first transaction has removed one owner and not committed, so the
   * second, which removes the other, can't yet see that. It must wait for the
   * outcome rather than act on its stale count.
   */
  async function race(
    isolation: string,
    first: (id: string) => string,
    second: (id: string) => string,
  ) {
    const { restaurantId, ownerId } = await restaurantWithOwner();
    const otherId = await addMember(restaurantId);
    const [one, two] = [
      await begin(restaurantId, isolation),
      await begin(restaurantId, isolation),
    ];
    try {
      // Take both snapshots before either change, the worst case for REPEATABLE READ.
      await one.query("select count(*) from staff");
      await two.query("select count(*) from staff");

      await one.query(first(ownerId));
      const pid = await backendPid(two);
      const racing = two.query(second(otherId)).then(
        () => "succeeded",
        (error: { code?: string; constraint?: string }) =>
          error.constraint ?? error.code ?? "failed",
      );
      await waitUntilBlocked(pid);
      await one.query("commit");

      const outcome = await racing;
      await two.query(outcome === "succeeded" ? "commit" : "rollback");
      return { outcome, owners: await activeOwners(restaurantId) };
    } finally {
      // Destroyed rather than returned: a failed test can leave them mid-transaction.
      one.release(true);
      two.release(true);
    }
  }

  const demote = (id: string) => `update staff set role = 'staff' where id = '${id}'`;
  const deactivate = (id: string) => `update staff set active = false where id = '${id}'`;
  const remove = (id: string) => `delete from staff where id = '${id}'`;

  it.each([
    ["demote and demote", demote, demote],
    ["demote and deactivate", demote, deactivate],
    ["deactivate and delete", deactivate, remove],
    ["delete and delete", remove, remove],
  ])("READ COMMITTED: %s can't both succeed", async (_name, first, second) => {
    expect(await race("read committed", first, second)).toEqual({
      outcome: "staff_last_active_owner",
      owners: 1,
    });
  });

  it("REPEATABLE READ: the second fails too, on the serialization check", async () => {
    expect(await race("repeatable read", demote, demote)).toEqual({
      outcome: "40001",
      owners: 1,
    });
  });
});
