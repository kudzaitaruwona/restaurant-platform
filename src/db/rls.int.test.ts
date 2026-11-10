import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  openOwnerDatabase,
  openTestDatabase,
} from "../../test/integration/database";

const app = openTestDatabase();
const owner = openOwnerDatabase();
afterAll(() => Promise.all([app.pool.end(), owner.pool.end()]));

const INSUFFICIENT_PRIVILEGE = "42501";

const count = async (database: typeof app.db, table: string) => {
  const { rows } = await database.execute(
    sql`select count(*)::int as count from ${sql.identifier(table)}`,
  );
  return rows[0].count;
};

describe("the app's database role", () => {
  it("is one RLS applies to: no superuser, no BYPASSRLS", async () => {
    const { rows } = await app.db.execute(sql`
      select rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
      from pg_roles where rolname = current_user
    `);
    expect(rows).toEqual([
      {
        rolname: "app_tenant",
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
      },
    ]);
  });

  it("owns nothing, because table owners skip RLS", async () => {
    const { rows } = await app.db.execute(sql`
      select c.relname from pg_class c
      where pg_get_userbyid(c.relowner) = current_user
    `);
    expect(rows).toEqual([]);
  });

  it("can't change the schema or read the migration history", async () => {
    await expect(
      app.db.execute(sql`create table public.not_allowed (id int)`),
    ).rejects.toMatchObject({ cause: { code: INSUFFICIENT_PRIVILEGE } });
    await expect(
      app.db.execute(sql`select * from drizzle.__drizzle_migrations`),
    ).rejects.toMatchObject({ cause: { code: INSUFFICIENT_PRIVILEGE } });
  });

  it("can't create or delete a restaurant: tenants are made by the platform", async () => {
    await expect(
      app.db.execute(sql`delete from restaurants`),
    ).rejects.toMatchObject({ cause: { code: INSUFFICIENT_PRIVILEGE } });
    await expect(
      app.db.execute(sql`
        insert into restaurants (name, slug, menu_token, currency_mode)
        values ('x', 'x', 'x', 'usd_only')
      `),
    ).rejects.toMatchObject({ cause: { code: INSUFFICIENT_PRIVILEGE } });
  });
});

describe("row-level security coverage", () => {
  // Reads the catalog rather than a list, so a new table can't skip RLS.
  const tenantTables = async () => {
    const { rows } = await owner.db.execute(sql`
      select c.relname as table,
             c.relrowsecurity as enabled,
             (select count(*)::int from pg_policies p
              where p.schemaname = 'public' and p.tablename = c.relname
                and p.cmd = 'ALL'
                and p.qual like '%app.restaurant_id%'
                and p.with_check like '%app.restaurant_id%') as policies
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
        and (c.relname = 'restaurants' or exists (
          select from pg_attribute a
          where a.attrelid = c.oid and a.attname = 'restaurant_id'
            and not a.attisdropped))
      order by c.relname
    `);
    return rows;
  };

  it("finds the tenant tables", async () => {
    const tables = (await tenantTables()).map((row) => row.table);
    expect(tables).toEqual(expect.arrayContaining(["restaurants", "staff"]));
  });

  it("every table with restaurant_id, and restaurants itself, has RLS on and a tenant policy", async () => {
    const uncovered = (await tenantTables()).filter(
      (row) => row.enabled !== true || row.policies !== 1,
    );
    expect(uncovered).toEqual([]);
  });

  // A view has no RLS of its own and runs as its owner, which RLS skips, so the
  // app role may read none: 0002's default privileges would hand it each new one.
  it("every public table the app role can read has RLS on, and it can read no view", async () => {
    const { rows } = await owner.db.execute(sql`
      select c.relname as table from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
        and not c.relrowsecurity
        and has_table_privilege('app_tenant', c.oid, 'select')
    `);
    expect(rows).toEqual([]);
  });
});

describe("composite key coverage", () => {
  // Every foreign key from one tenant table to another, read from the catalog,
  // so a new one can't skip this. `restaurants` is the tenant root: a plain
  // restaurant_id -> restaurants(id) key is the point of it, so it isn't counted.
  const tenantForeignKeys = async () => {
    const { rows } = await owner.db.execute(sql`
      select con.conname as name,
             exists (
               select from unnest(con.conkey, con.confkey) as pair(local, parent)
               join pg_attribute l on l.attrelid = con.conrelid and l.attnum = pair.local
               join pg_attribute p on p.attrelid = con.confrelid and p.attnum = pair.parent
               where l.attname = 'restaurant_id' and p.attname = 'restaurant_id'
             ) as composite
      from pg_constraint con
      join pg_namespace n on n.oid = con.connamespace
      where con.contype = 'f' and n.nspname = 'public'
        and exists (select from pg_attribute a where a.attrelid = con.conrelid
                    and a.attname = 'restaurant_id' and not a.attisdropped)
        and exists (select from pg_attribute a where a.attrelid = con.confrelid
                    and a.attname = 'restaurant_id' and not a.attisdropped)
      order by con.conname
    `);
    return rows;
  };

  it("finds the tenant foreign keys", async () => {
    const names = (await tenantForeignKeys()).map((row) => row.name);
    expect(names).toContain("menu_items_category_fk");
  });

  it("every foreign key between tenant tables pairs restaurant_id with restaurant_id", async () => {
    const single = (await tenantForeignKeys()).filter((row) => !row.composite);
    expect(single).toEqual([]);
  });

  it("every tenant table has the UNIQUE (restaurant_id, id) a composite key points at", async () => {
    const { rows } = await owner.db.execute(sql`
      select c.relname as table from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
        and exists (select from pg_attribute a where a.attrelid = c.oid
                    and a.attname = 'restaurant_id' and not a.attisdropped)
        and not exists (
          select from pg_constraint u
          where u.conrelid = c.oid and u.contype in ('u', 'p')
            and (select array_agg(a.attname::text order by a.attname)
                 from pg_attribute a
                 where a.attrelid = c.oid and a.attnum = any (u.conkey))
                = array['id', 'restaurant_id']
        )
    `);
    expect(rows).toEqual([]);
  });
});

describe("a query outside any tenant", () => {
  it.each(["restaurants", "staff"])(
    "sees no rows in %s, though the table has rows",
    async (table) => {
      expect(await count(owner.db, table)).toBeGreaterThan(0);
      expect(await count(app.db, table)).toBe(0);
    },
  );

  it("sees no rows on a connection a tenant just used, without an error", async () => {
    // After a transaction-local set_config the setting reverts to '' rather
    // than to unset, and ''::uuid would throw. One client: the same connection.
    const client = await app.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "select set_config('app.restaurant_id', gen_random_uuid()::text, true)",
      );
      await client.query("commit");

      const { rows } = await client.query("select * from staff");
      expect(rows).toEqual([]);
    } finally {
      client.release();
    }
  });

  it("can't write: inserting a staff row is rejected by the policy", async () => {
    const { rows } = await owner.db.execute(
      sql`select id from restaurants limit 1`,
    );
    await expect(
      app.db.execute(sql`
        insert into staff (restaurant_id, email, display_name)
        values (${rows[0].id}, 'nobody@example.test', 'Nobody')
      `),
    ).rejects.toMatchObject({ cause: { code: INSUFFICIENT_PRIVILEGE } });
  });
});
