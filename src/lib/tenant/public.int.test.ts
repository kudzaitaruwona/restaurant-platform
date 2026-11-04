import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { categories } from "@/db/schema";
import {
  openOwnerDatabase,
  openTestDatabase,
  testDatabaseSettings,
} from "../../../test/integration/database";
import { devRestaurants } from "./dev-identities";
import { resolvePublicToken } from "./public";
import { withTenant } from "./scope";

/**
 * A public route has no session, so its token is the only way to a tenant
 * (spec 01 › Tenant isolation). RLS rightly hides `restaurants` before one is
 * known, so the lookup is a SECURITY DEFINER function, driven here as app_tenant.
 */
const app = openTestDatabase();
const owner = openOwnerDatabase();

const [restaurantA, restaurantB] = devRestaurants;
const menuTokenOf = ({ slug }: { slug: string }) => `dev-menu-${slug}`;

beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});
afterAll(async () => {
  await Promise.all([app.pool.end(), owner.pool.end()]);
  vi.unstubAllEnvs();
});

describe("resolvePublicToken", () => {
  it("finds the restaurant a menu token belongs to", async () => {
    expect(await resolvePublicToken("menu", menuTokenOf(restaurantA))).toEqual({
      restaurantId: restaurantA.id,
    });
    expect(await resolvePublicToken("menu", menuTokenOf(restaurantB))).toEqual({
      restaurantId: restaurantB.id,
    });
  });

  it.each(["", "not-a-token", "%", "dev-menu-%", "' or 1=1 --"])(
    "finds nothing for %j",
    async (token) => {
      expect(await resolvePublicToken("menu", token)).toBeUndefined();
    },
  );

  it("is exact: a token differing only in case is a different token", async () => {
    expect(
      await resolvePublicToken("menu", menuTokenOf(restaurantA).toUpperCase()),
    ).toBeUndefined();
  });

  it("opens exactly one tenant: what it returns scopes withTenant to that restaurant", async () => {
    const tenant = await resolvePublicToken("menu", menuTokenOf(restaurantA));
    const { rows } = await withTenant(tenant!, (tx) =>
      tx.execute(sql`select id from restaurants`),
    );
    expect(rows).toEqual([{ id: restaurantA.id }]);
  });

  it("leaves no tenant behind on the connection", async () => {
    await resolvePublicToken("menu", menuTokenOf(restaurantA));
    const { rows } = await app.db.execute(sql`select id from restaurants`);
    expect(rows).toEqual([]);
  });
});

describe("restaurant_id_by_menu_token, as app_tenant with no tenant set", () => {
  it("returns the id and nothing else: the table also holds Wi-Fi passwords", async () => {
    const { rows } = await app.db.execute(
      sql`select * from restaurant_id_by_menu_token(${menuTokenOf(restaurantA)})`,
    );
    expect(rows).toEqual([{ restaurant_id_by_menu_token: restaurantA.id }]);
  });

  it("opens no rows by itself: the tables stay hidden afterwards", async () => {
    await app.db.execute(
      sql`select restaurant_id_by_menu_token(${menuTokenOf(restaurantA)})`,
    );
    expect(
      await app.db
        .select({ id: categories.id })
        .from(categories)
        .where(eq(categories.restaurantId, restaurantA.id)),
    ).toEqual([]);
  });
});

describe("how the function is locked down", () => {
  const name = "restaurant_id_by_menu_token";

  it("is SECURITY DEFINER with a fixed search_path", async () => {
    const { rows } = await owner.db.execute(sql`
      select prosecdef, proconfig from pg_proc
      where proname = ${name} and pronamespace = 'public'::regnamespace
    `);
    expect(rows).toEqual([
      { prosecdef: true, proconfig: ["search_path=pg_catalog, pg_temp"] },
    ]);
  });

  it("can be executed by app_tenant and not by PUBLIC", async () => {
    const { rows } = await owner.db.execute(sql`
      select coalesce(grantee.rolname, 'PUBLIC') as grantee
      from pg_proc p
      cross join lateral aclexplode(p.proacl) acl
      left join pg_roles grantee on grantee.oid = acl.grantee
      where p.proname = ${name} and p.pronamespace = 'public'::regnamespace
        and acl.privilege_type = 'EXECUTE'
        and acl.grantee <> p.proowner
    `);
    expect(rows).toEqual([{ grantee: "app_tenant" }]);
  });
});
