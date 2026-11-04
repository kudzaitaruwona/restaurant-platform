import { sql, type SQL } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  openAdminDatabase,
  openOwnerDatabase,
  openTestDatabase,
} from "../../test/integration/database";
import { devPlatformAdmin, devRestaurants } from "../lib/tenant/dev-identities";

/**
 * The separate admin login (S-28), proved from Postgres itself. Everything here
 * is what SQL run as app_tenant can no longer do, whatever it does to its own
 * settings first. No application code is involved, because the attacker this
 * guards against has got past the application.
 */
const app = openTestDatabase();
const admin = openAdminDatabase();
const owner = openOwnerDatabase();
afterAll(() =>
  Promise.all([app.pool.end(), admin.pool.end(), owner.pool.end()]),
);

const INSUFFICIENT_PRIVILEGE = "42501";
const refused = { cause: { code: INSUFFICIENT_PRIVILEGE } };

const adminId: string = devPlatformAdmin.platformAdminId;
const [restaurantA] = devRestaurants.map((restaurant) => restaurant.id);

/** What the attack starts with: no tenant, in the same transaction as `query`. */
const asTenantRoleWithNoTenant = (query: SQL) =>
  app.db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.restaurant_id', '', true)`);
    return tx.execute(query);
  });

const adminAuthTables = async () => {
  const { rows } = await owner.db.execute<{ name: string }>(sql`
    select c.relname as name from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
      and c.relname like 'admin\\_auth\\_%'
    order by c.relname
  `);
  return rows.map(({ name }) => name);
};

describe("app_admin", () => {
  it("is a login RLS applies to, like app_tenant", async () => {
    const { rows } = await admin.db.execute(sql`
      select rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin
      from pg_roles where rolname = current_user
    `);
    expect(rows).toEqual([
      {
        rolname: "app_admin",
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolcanlogin: true,
      },
    ]);
  });

  it("owns nothing", async () => {
    const { rows } = await admin.db.execute(sql`
      select c.relname from pg_class c
      where pg_get_userbyid(c.relowner) = current_user
    `);
    expect(rows).toEqual([]);
  });

  it("isn't related to app_tenant, so neither can become the other", async () => {
    const { rows } = await owner.db.execute(sql`
      select pg_has_role('app_tenant', 'app_admin', 'member') as tenant_is_admin,
             pg_has_role('app_admin', 'app_tenant', 'member') as admin_is_tenant
    `);
    expect(rows).toEqual([{ tenant_is_admin: false, admin_is_tenant: false }]);
    await expect(
      app.db.transaction((tx) => tx.execute(sql`set local role app_admin`)),
    ).rejects.toMatchObject(refused);
  });

  it("can reach no table but its own: no tenant data, no staff credentials", async () => {
    const { rows } = await owner.db.execute(sql`
      select c.relname as name from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
        and c.relname not like 'admin\\_auth\\_%'
        and has_table_privilege('app_admin', c.oid, 'select, insert, update, delete')
    `);
    expect(rows).toEqual([]);
    await expect(admin.db.execute(sql`select * from staff`)).rejects.toMatchObject(refused);
    await expect(admin.db.execute(sql`select * from audit_log`)).rejects.toMatchObject(refused);
  });
});

describe("app_admin on who is in which restaurant", () => {
  it("can read an entry but can't write one, so every change goes through the audited functions", async () => {
    for (const statement of [
      sql`insert into admin_auth_entry (session_id, entered_restaurant_id, shadow_staff_id) values ('s', ${restaurantA}, ${restaurantA})`,
      sql`update admin_auth_entry set entered_restaurant_id = ${restaurantA}`,
      sql`delete from admin_auth_entry`,
    ]) {
      await expect(admin.db.execute(statement)).rejects.toMatchObject(refused);
    }
    await expect(
      admin.db.execute(sql`select * from admin_auth_entry limit 1`),
    ).resolves.toBeDefined();
  });
});

describe("app_tenant, with app.restaurant_id cleared", () => {
  const platformFunctions = [
    [
      "platform_create_restaurant",
      sql`select platform_create_restaurant(${adminId}, 'Junk', ${`junk-${crypto.randomUUID()}`}, 'Africa/Harare', 'usd_only')`,
    ],
    [
      "platform_create_first_owner",
      sql`select platform_create_first_owner(${adminId}, ${restaurantA}, ${`${crypto.randomUUID()}@example.test`}, 'Planted')`,
    ],
    ["platform_list_restaurants", sql`select * from platform_list_restaurants(${adminId})`],
    ["platform_list_booking_metrics", sql`select * from platform_list_booking_metrics(${adminId})`],
    ["platform_admin_id_by_email", sql`select platform_admin_id_by_email(${devPlatformAdmin.email})`],
    ["platform_enter_restaurant", sql`select platform_enter_restaurant(${adminId}, ${devPlatformAdmin.sessionId}, ${restaurantA})`],
    ["platform_leave_restaurant", sql`select platform_leave_restaurant(${adminId}, ${devPlatformAdmin.sessionId})`],
    ["platform_onboarding_checklist", sql`select * from platform_onboarding_checklist(${adminId})`],
    ["platform_set_qr_codes_printed", sql`select platform_set_qr_codes_printed(${adminId}, ${restaurantA}, true)`],
  ] as const;

  it.each(platformFunctions)("can't call %s", async (_name, call) => {
    await expect(asTenantRoleWithNoTenant(call)).rejects.toMatchObject(refused);
  });

  it("covers every platform_ function there is, so a new one can't be missed", async () => {
    const { rows } = await owner.db.execute<{ name: string; executors: string[] }>(sql`
      select p.proname as name,
             array(
               select case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end
               from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
               where a.privilege_type = 'EXECUTE' and a.grantee <> p.proowner
             ) as executors
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like 'platform\\_%'
        and p.proname <> 'platform_assert_admin'
      order by p.proname
    `);
    expect(rows.map(({ name }) => name)).toEqual(
      platformFunctions.map(([name]) => name).sort(),
    );
    for (const { name, executors } of rows) {
      expect(executors, name).toEqual(["app_admin"]);
    }
  });

  it("can't read or change the onboarding checklist, which is the admin's alone", async () => {
    for (const statement of [
      sql`select * from onboarding_checklist`,
      sql`insert into onboarding_checklist (restaurant_id, qr_codes_printed_by) values (${restaurantA}, ${adminId})`,
      sql`delete from onboarding_checklist`,
    ]) {
      await expect(
        app.db.transaction(async (tx) => {
          await tx.execute(sql`select set_config('app.restaurant_id', ${restaurantA}, true)`);
          return tx.execute(statement);
        }),
      ).rejects.toMatchObject(refused);
    }
  });

  it("can't plant a magic link for a platform admin (S-30)", async () => {
    await expect(
      asTenantRoleWithNoTenant(sql`
        insert into admin_auth_verification (id, identifier, value, expires_at)
        values (${crypto.randomUUID()}, 'planted-token', '{"email":"x@example.test"}', now() + interval '1 hour')
      `),
    ).rejects.toMatchObject(refused);
  });

  it("can't plant a session for a platform admin", async () => {
    await expect(
      asTenantRoleWithNoTenant(sql`
        insert into admin_auth_session (id, token, user_id, expires_at)
        values (${crypto.randomUUID()}, 'planted', ${devPlatformAdmin.sessionId}, now() + interval '1 hour')
      `),
    ).rejects.toMatchObject(refused);
  });

  it("finds the admin auth tables, so the next test tests something", async () => {
    expect(await adminAuthTables()).toEqual(
      expect.arrayContaining(["admin_auth_session", "admin_auth_verification"]),
    );
  });

  it("holds no privilege at all on any admin auth table, whatever arrives later", async () => {
    const { rows } = await owner.db.execute(sql`
      select c.relname as name from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
        and c.relname like 'admin\\_auth\\_%'
        and has_table_privilege('app_tenant', c.oid, 'select, insert, update, delete, truncate, references, trigger')
    `);
    expect(rows).toEqual([]);
  });

  it.each(["select", "update", "delete"])("can't %s admin sessions", async (verb) => {
    const statements: Record<string, SQL> = {
      select: sql`select * from admin_auth_session`,
      update: sql`update admin_auth_session set expires_at = now() + interval '10 years'`,
      delete: sql`delete from admin_auth_session`,
    };
    await expect(asTenantRoleWithNoTenant(statements[verb])).rejects.toMatchObject(refused);
  });
});
