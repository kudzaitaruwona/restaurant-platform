import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { restaurants, staff } from "@/db/schema";
import {
  openOwnerDatabase,
  testDatabaseSettings,
} from "../../../test/integration/database";
import { statusOf } from "../../../test/integration/http";
import { devIdentities } from "./dev-identities";

// The one thing faked here is the request: the cookie jar. Everything behind it
// is real, through the RLS-bound role.
const request = vi.hoisted(() => ({ identity: undefined as string | undefined }));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) =>
      request.identity === undefined
        ? undefined
        : { name, value: request.identity },
  }),
}));

// An identity whose staff row the test deactivates. The seeded rows stay as
// they are, because test files share the database.
const former = vi.hoisted(() => ({
  key: "a-former",
  label: "Former staff",
  restaurantId: "00000000-0000-4000-8000-00000000000a",
  staffId: crypto.randomUUID(),
  role: "staff",
}));

vi.mock("./dev-identities", async (original) => {
  const actual = await original<typeof import("./dev-identities")>();
  return {
    ...actual,
    findDevIdentity: (key: string) =>
      key === former.key ? former : actual.findDevIdentity(key),
  };
});

const [aOwner, aStaff, bOwner] = devIdentities;

const owner = openOwnerDatabase();
beforeAll(async () => {
  await owner.db.insert(staff).values({
    id: former.staffId,
    restaurantId: former.restaurantId,
    email: `${former.staffId}@example.test`,
    displayName: former.label,
    role: "owner", // the identity list says "staff"
  });
});
afterAll(async () => {
  await owner.db.delete(staff).where(eq(staff.id, former.staffId));
  await owner.pool.end();
  vi.unstubAllEnvs();
});

async function seam() {
  vi.resetModules(); // fresh env cache per test
  return import("@/lib/tenant");
}

beforeEach(() => {
  request.identity = undefined;
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
  vi.stubEnv("DEV_AUTH_BYPASS", "1");
  vi.stubEnv("NODE_ENV", "test");
});

describe("getTenantContext with DEV_AUTH_BYPASS", () => {
  it("returns the default seeded owner before anyone has switched", async () => {
    const { getTenantContext } = await seam();
    expect(await getTenantContext()).toEqual({
      restaurantId: aOwner.restaurantId,
      staffId: aOwner.staffId,
      role: "owner",
    });
  });

  it.each(devIdentities.map((identity) => [identity.key, identity] as const))(
    "returns the switched-to identity: %s",
    async (key, identity) => {
      request.identity = key;
      const { getTenantContext } = await seam();
      expect(await getTenantContext()).toEqual({
        restaurantId: identity.restaurantId,
        staffId: identity.staffId,
        role: identity.role,
      });
    },
  );

  it.each([
    "nobody",
    "__proto__",
    aOwner.staffId, // a raw id is not a key: the cookie can't name a tenant
    aOwner.restaurantId,
  ])("refuses a cookie that isn't a seeded identity: %s", async (value) => {
    request.identity = value;
    const { getTenantContext } = await seam();
    expect(await statusOf(getTenantContext)).toBe(401);
  });

  it("takes the role from the database, not from the identity list", async () => {
    request.identity = former.key;
    const { getTenantContext } = await seam();
    expect(await getTenantContext()).toMatchObject({ role: "owner" });
  });

  it("refuses inactive staff", async () => {
    await owner.db
      .update(staff)
      .set({ active: false })
      .where(eq(staff.id, former.staffId));

    request.identity = former.key;
    const { getTenantContext } = await seam();
    expect(await statusOf(getTenantContext)).toBe(401);
  });
});

describe("getTenantContext without the bypass", () => {
  it("ignores the dev cookie when DEV_AUTH_BYPASS is unset: only a session counts", async () => {
    vi.stubEnv("DEV_AUTH_BYPASS", "");
    request.identity = aOwner.key;
    const { getTenantContext } = await seam();
    expect(await statusOf(getTenantContext)).toBe(401);
  });

  it("refuses everyone in production, even with the variable and cookie present", async () => {
    vi.stubEnv("NODE_ENV", "production");
    request.identity = aOwner.key;
    const { getTenantContext } = await seam();
    expect(await statusOf(getTenantContext)).toBe(401);
  });
});

describe("requireOwner", () => {
  it("lets an owner through", async () => {
    const { requireOwner } = await seam();
    expect(() =>
      requireOwner({
        restaurantId: aOwner.restaurantId,
        staffId: aOwner.staffId,
        role: "owner",
      }),
    ).not.toThrow();
  });

  it("gives a staff context a 403", async () => {
    const { requireOwner } = await seam();
    const status = await statusOf(async () =>
      requireOwner({
        restaurantId: aStaff.restaurantId,
        staffId: aStaff.staffId,
        role: "staff",
      }),
    );
    expect(status).toBe(403);
  });
});

describe("withTenant", () => {
  const a: { restaurantId: string } = { restaurantId: aOwner.restaurantId };
  const b: { restaurantId: string } = { restaurantId: bOwner.restaurantId };

  it("sets app.restaurant_id for the transaction", async () => {
    const { withTenant } = await seam();
    const setting = await withTenant(a, async (tx) => {
      const { rows } = await tx.execute(
        sql`select current_setting('app.restaurant_id') as value`,
      );
      return rows[0].value;
    });
    expect(setting).toBe(aOwner.restaurantId);
  });

  it("leaves nothing behind on the pooled connection for the next query", async () => {
    const { withTenant } = await seam();
    const { getDb } = await import("@/db");
    const pid = sql`select pg_backend_pid() as pid`;

    const used = await withTenant(a, async (tx) => (await tx.execute(pid)).rows[0].pid);

    // A fresh pool that has only ever needed one connection hands the same one
    // back. Checked, because the test proves nothing on a different connection.
    const { rows } = await getDb().execute(sql`
      select pg_backend_pid() as pid,
             current_setting('app.restaurant_id', true) as setting,
             (select count(*)::int from staff) as visible
    `);
    expect(rows).toEqual([{ pid: used, setting: "", visible: 0 }]);
  });

  it("shows only the tenant's own rows", async () => {
    const { withTenant } = await seam();
    const seen = await withTenant(a, async (tx) => ({
      restaurants: await tx.select({ id: restaurants.id }).from(restaurants),
      staff: await tx
        .select({ restaurantId: staff.restaurantId })
        .from(staff),
    }));
    expect(seen.restaurants).toEqual([{ id: aOwner.restaurantId }]);
    expect(seen.staff.length).toBeGreaterThanOrEqual(2);
    expect(
      seen.staff.every((row) => row.restaurantId === aOwner.restaurantId),
    ).toBe(true);
  });

  it("keeps concurrent tenants apart", async () => {
    const { withTenant } = await seam();
    const ownRestaurant = (ctx: typeof a) =>
      withTenant(ctx, (tx) =>
        tx.select({ id: restaurants.id }).from(restaurants),
      );
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        ownRestaurant(index % 2 ? b : a).then((rows) => ({
          expected: (index % 2 ? b : a).restaurantId,
          rows,
        })),
      ),
    );
    for (const { expected, rows } of results) {
      expect(rows).toEqual([{ id: expected }]);
    }
  });

  it("can't reach another tenant's rows by id", async () => {
    const { withTenant } = await seam();
    const { seen, updated } = await withTenant(a, async (tx) => ({
      seen: await tx.select().from(staff).where(eq(staff.id, bOwner.staffId)),
      updated: await tx
        .update(staff)
        .set({ displayName: "Hijacked" })
        .where(eq(staff.id, bOwner.staffId))
        .returning(),
    }));
    expect(seen).toEqual([]);
    expect(updated).toEqual([]);
  });

  it("can't write a row into another tenant", async () => {
    const { withTenant } = await seam();
    await expect(
      withTenant(a, (tx) =>
        tx.insert(staff).values({
          restaurantId: bOwner.restaurantId,
          email: `${crypto.randomUUID()}@example.test`,
          displayName: "Planted",
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
  });

  it("rolls back when fn throws", async () => {
    const { withTenant } = await seam();
    const email = `${crypto.randomUUID()}@example.test`;
    await expect(
      withTenant(a, async (tx) => {
        await tx.insert(staff).values({
          restaurantId: aOwner.restaurantId,
          email,
          displayName: "Rolled back",
        });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const rows = await owner.db.select().from(staff).where(eq(staff.email, email));
    expect(rows).toEqual([]);
  });
});
