import { sql, type SQL } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  openAdminDatabase,
  openOwnerDatabase,
  openStaffAuthDatabase,
  openTestDatabase,
} from "../../test/integration/database";
import { devIdentities } from "../lib/tenant/dev-identities";

/**
 * Staff sign-in's own login (S-28, S-30), proved from Postgres itself. A magic
 * link is only a row in staff_auth_verification, so whoever can write that table
 * can become any staff member. Everything here is what SQL run as app_tenant can
 * no longer do, whatever it does to its own settings first.
 */
const app = openTestDatabase();
const admin = openAdminDatabase();
const staffAuth = openStaffAuthDatabase();
const owner = openOwnerDatabase();
const tag = crypto.randomUUID();
afterAll(async () => {
  await owner.db.execute(
    sql`delete from staff_auth_verification where identifier like ${`planted-${tag}-%`}`,
  );
  await Promise.all([
    app.pool.end(),
    admin.pool.end(),
    staffAuth.pool.end(),
    owner.pool.end(),
  ]);
});

const INSUFFICIENT_PRIVILEGE = "42501";
const refused = { cause: { code: INSUFFICIENT_PRIVILEGE } };

const [aOwner] = devIdentities;
const logins = { app_tenant: app, app_admin: admin, app_staff_auth: staffAuth };
type Login = keyof typeof logins;

/** What the attack starts with: no tenant, in the same transaction as `query`. */
const withNoTenant = (login: Login, query: SQL) =>
  logins[login].db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.restaurant_id', '', true)`);
    return tx.execute(query);
  });

const tablesReachableBy = async (role: string) => {
  const { rows } = await owner.db.execute<{ name: string }>(sql`
    select c.relname as name from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
      and has_table_privilege(${role}, c.oid, 'select, insert, update, delete, truncate, references, trigger')
    order by c.relname
  `);
  return rows.map(({ name }) => name);
};

const staffAuthTables = async () => {
  const { rows } = await owner.db.execute<{ name: string }>(sql`
    select c.relname as name from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
      and c.relname like 'staff\\_auth\\_%'
    order by c.relname
  `);
  return rows.map(({ name }) => name);
};

const plantedLink = () => sql`
  insert into staff_auth_verification (id, identifier, value, expires_at)
  values (${crypto.randomUUID()}, ${`planted-${tag}-${crypto.randomUUID()}`}, '{"email":"x@example.test"}', now() + interval '1 hour')
`;

describe("app_staff_auth", () => {
  it("is a login RLS applies to, like app_tenant", async () => {
    const { rows } = await staffAuth.db.execute(sql`
      select rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin
      from pg_roles where rolname = current_user
    `);
    expect(rows).toEqual([
      {
        rolname: "app_staff_auth",
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolcanlogin: true,
      },
    ]);
  });

  it("owns nothing", async () => {
    const { rows } = await staffAuth.db.execute(sql`
      select c.relname from pg_class c
      where pg_get_userbyid(c.relowner) = current_user
    `);
    expect(rows).toEqual([]);
  });

  it("finds the staff auth tables, so the tests below test something", async () => {
    expect(await staffAuthTables()).toEqual(
      expect.arrayContaining([
        "staff_auth_code_limit",
        "staff_auth_session",
        "staff_auth_verification",
      ]),
    );
  });

  it("reaches the staff auth tables and no other table: no tenant data, no admin credentials", async () => {
    expect(await tablesReachableBy("app_staff_auth")).toEqual(await staffAuthTables());
    await expect(staffAuth.db.execute(sql`select * from staff`)).rejects.toMatchObject(refused);
    await expect(
      staffAuth.db.execute(sql`select * from admin_auth_verification`),
    ).rejects.toMatchObject(refused);
  });

  it("can find who an email belongs to, which sign-in needs, and call nothing else that bypasses RLS", async () => {
    const { rows } = await owner.db.execute<{ name: string }>(sql`
      select p.proname as name from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef
        and has_function_privilege('app_staff_auth', p.oid, 'execute')
    `);
    expect(rows.map(({ name }) => name).sort()).toEqual([
      "staff_identity_by_email",
      // Marks the person as joined on their first sign-in (S-42).
      "staff_record_first_sign_in",
    ]);
  });

  it("can write a sign-in link outside a tenant, as Better Auth does", async () => {
    await expect(withNoTenant("app_staff_auth", plantedLink())).resolves.toBeDefined();
  });

  it("sees nothing of its tables inside a tenant", async () => {
    const { rows } = await staffAuth.db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.restaurant_id', ${aOwner.restaurantId}, true)`,
      );
      return tx.execute(sql`select count(*)::int as count from staff_auth_verification`);
    });
    expect(rows).toEqual([{ count: 0 }]);
  });
});

describe("the three logins", () => {
  const pairs = (["app_tenant", "app_admin", "app_staff_auth"] as const).flatMap(
    (from) =>
      (["app_tenant", "app_admin", "app_staff_auth"] as const)
        .filter((to) => to !== from)
        .map((to) => [from, to] as const),
  );

  it.each(pairs)("%s can't become %s", async (from, to) => {
    const { rows } = await owner.db.execute(
      sql`select pg_has_role(${from}, ${to}, 'member') as member`,
    );
    expect(rows).toEqual([{ member: false }]);
    await expect(
      logins[from].db.transaction((tx) =>
        tx.execute(sql.raw(`set local role ${to}`)),
      ),
    ).rejects.toMatchObject(refused);
  });
});

describe("app_tenant, with app.restaurant_id cleared", () => {
  it("can't plant a magic link for a staff member (S-30)", async () => {
    await expect(withNoTenant("app_tenant", plantedLink())).rejects.toMatchObject(refused);
  });

  it("can't plant a session for a staff member", async () => {
    await expect(
      withNoTenant(
        "app_tenant",
        sql`
          insert into staff_auth_session (id, token, user_id, expires_at)
          values (${crypto.randomUUID()}, 'planted', 'someone', now() + interval '1 hour')
        `,
      ),
    ).rejects.toMatchObject(refused);
  });

  it("can't reset someone's code limit", async () => {
    await expect(
      withNoTenant("app_tenant", sql`delete from staff_auth_code_limit`),
    ).rejects.toMatchObject(refused);
  });

  it("can't look up who an email belongs to", async () => {
    await expect(
      withNoTenant(
        "app_tenant",
        sql`select * from staff_identity_by_email(${`${aOwner.key}@dev.example.test`})`,
      ),
    ).rejects.toMatchObject(refused);
  });

  it.each(["app_tenant", "app_admin"] as const)(
    "%s can't mark someone as joined (S-42)",
    async (login) => {
      await expect(
        withNoTenant(
          login,
          sql`select staff_record_first_sign_in(${`${aOwner.key}@dev.example.test`})`,
        ),
      ).rejects.toMatchObject(refused);
    },
  );

  it("holds no privilege at all on any staff auth table, whatever arrives later", async () => {
    const reachable = await tablesReachableBy("app_tenant");
    expect(reachable.filter((name) => name.startsWith("staff_auth_"))).toEqual([]);
  });

  it("nor does the admin login", async () => {
    const reachable = await tablesReachableBy("app_admin");
    expect(reachable.filter((name) => name.startsWith("staff_auth_"))).toEqual([]);
  });
});
