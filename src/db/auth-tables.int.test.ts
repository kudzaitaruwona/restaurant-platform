import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  openAdminDatabase,
  openOwnerDatabase,
  openTestDatabase,
} from "../../test/integration/database";
import { devIdentities } from "../lib/tenant/dev-identities";
import { staff, staffAuthSession, staffAuthUser } from "./schema";

/**
 * Better Auth's tables hold sessions and sign-in tokens. They're used before any
 * tenant is known, so they can't have a tenant policy. Instead they're visible
 * only OUTSIDE a tenant: nothing inside withTenant() can read or touch a
 * credential, and that is all the code the app runs on tenant data. The staff
 * tables are app_tenant's and the admin tables app_admin's, and
 * admin-role.int.test.ts proves app_tenant can't reach the admin ones at all.
 */
const app = openTestDatabase();
const adminLogin = openAdminDatabase();
const owner = openOwnerDatabase();

const models = [
  "user",
  "session",
  "account",
  "verification",
  "rate_limit",
  "code_limit",
];
const tablesOf = (prefix: string) =>
  models.map((model) => `${prefix}_auth_${model}`);
const adminTables = [...tablesOf("admin"), "admin_auth_entry"];
const tables = [...tablesOf("staff"), ...adminTables];

const [aOwner] = devIdentities;
const userId = `user-${crypto.randomUUID()}`;
const email = `${userId}@example.test`;

const now = new Date();
const later = new Date(Date.now() + 60_000);

beforeAll(async () => {
  await owner.db.insert(staffAuthUser).values({
    id: userId,
    name: "",
    email,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  await owner.db.insert(staffAuthSession).values({
    id: `session-${userId}`,
    token: `token-${userId}`,
    userId,
    expiresAt: later,
    createdAt: now,
    updatedAt: now,
  });
});

afterAll(async () => {
  await owner.db.delete(staffAuthUser).where(eq(staffAuthUser.id, userId));
  await Promise.all([app.pool.end(), adminLogin.pool.end(), owner.pool.end()]);
});

const insideATenant = <T>(fn: (tx: typeof app.db) => Promise<T>, login = app) =>
  login.db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.restaurant_id', ${aOwner.restaurantId}, true)`,
    );
    return fn(tx as unknown as typeof app.db);
  });

describe("the auth tables", () => {
  it.each(tables)("%s has RLS on and a policy of its own", async (table) => {
    const { rows } = await owner.db.execute(sql`
      select c.relrowsecurity as enabled,
             (select count(*)::int from pg_policies p
              where p.schemaname = 'public' and p.tablename = c.relname
                and p.policyname = 'outside_tenant_only' and p.cmd = 'ALL') as policies
      from pg_class c
      where c.oid = ${`public.${table}`}::regclass
    `);
    expect(rows).toEqual([{ enabled: true, policies: 1 }]);
  });

  it("have no column that could hold a password or an OAuth token (S-27)", async () => {
    const { rows } = await owner.db.execute(sql`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public'
        and table_name like any (array['staff_auth_%', 'admin_auth_%'])
        and column_name ~ '(password|access_token|refresh_token|id_token)'
    `);
    expect(rows).toEqual([]);
  });

  it("no password column exists on staff or platform_admins either", async () => {
    const { rows } = await owner.db.execute(sql`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name in ('staff', 'platform_admins')
        and column_name like '%password%'
    `);
    expect(rows).toEqual([]);
  });
});

describe("as app_tenant", () => {
  it("outside a tenant, Better Auth can read them", async () => {
    const rows = await app.db
      .select({ userId: staffAuthSession.userId })
      .from(staffAuthSession)
      .where(eq(staffAuthSession.token, `token-${userId}`));
    expect(rows).toEqual([{ userId }]);
  });

  it("outside a tenant on a connection a tenant just used, too", async () => {
    const client = await app.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "select set_config('app.restaurant_id', gen_random_uuid()::text, true)",
      );
      await client.query("commit");
      const { rows } = await client.query(
        "select 1 from staff_auth_session where token = $1",
        [`token-${userId}`],
      );
      expect(rows).toHaveLength(1);
    } finally {
      client.release();
    }
  });

  const countIn = (table: string) => (tx: typeof app.db) =>
    tx.execute(sql`select count(*)::int as count from ${sql.identifier(table)}`);

  it.each(tablesOf("staff"))("inside a tenant, %s shows nothing", async (table) => {
    const { rows } = await insideATenant(countIn(table));
    expect(rows).toEqual([{ count: 0 }]);
  });

  it.each(adminTables)(
    "even the admin login sees nothing of %s inside a tenant",
    async (table) => {
      const { rows } = await insideATenant(countIn(table), adminLogin);
      expect(rows).toEqual([{ count: 0 }]);
    },
  );

  it("inside a tenant, a session can't be forged", async () => {
    await expect(
      insideATenant((tx) =>
        tx.insert(staffAuthSession).values({
          id: `forged-${userId}`,
          token: `forged-${userId}`,
          userId,
          expiresAt: later,
          createdAt: now,
          updatedAt: now,
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
  });

  it("inside a tenant, a session can't be extended or deleted", async () => {
    await insideATenant(async (tx) => {
      await tx
        .update(staffAuthSession)
        .set({ expiresAt: new Date(0) })
        .where(eq(staffAuthSession.userId, userId));
      await tx.delete(staffAuthSession).where(eq(staffAuthSession.userId, userId));
    });
    const [row] = await owner.db
      .select({ expiresAt: staffAuthSession.expiresAt })
      .from(staffAuthSession)
      .where(eq(staffAuthSession.userId, userId));
    expect(row.expiresAt).toEqual(later);
  });
});

describe("deactivating staff kills their sessions, in Postgres", () => {
  const subject = crypto.randomUUID();
  const subjectEmail = `${subject}@example.test`;
  const subjectUser = `user-${subject}`;

  const sessionsLeft = async () =>
    (
      await owner.db
        .select({ id: staffAuthSession.id })
        .from(staffAuthSession)
        .where(eq(staffAuthSession.userId, subjectUser))
    ).length;

  const signIn = () =>
    owner.db.insert(staffAuthSession).values({
      id: `session-${crypto.randomUUID()}`,
      token: `token-${crypto.randomUUID()}`,
      userId: subjectUser,
      expiresAt: later,
      createdAt: now,
      updatedAt: now,
    });

  beforeAll(async () => {
    await owner.db.insert(staff).values({
      id: subject,
      restaurantId: aOwner.restaurantId,
      email: subjectEmail,
      displayName: "Subject",
    });
    await owner.db.insert(staffAuthUser).values({
      id: subjectUser,
      name: "",
      email: subjectEmail,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
  });

  afterAll(async () => {
    await owner.db.delete(staffAuthUser).where(eq(staffAuthUser.id, subjectUser));
    await owner.db.delete(staff).where(eq(staff.id, subject));
  });

  it("through the role the app uses, inside a tenant, where it can't see sessions", async () => {
    await signIn();
    await insideATenant((tx) =>
      tx.update(staff).set({ active: false }).where(eq(staff.id, subject)),
    );
    expect(await sessionsLeft()).toBe(0);
  });

  it("so reactivating them doesn't bring an old tablet back", async () => {
    await owner.db.update(staff).set({ active: true }).where(eq(staff.id, subject));
    expect(await sessionsLeft()).toBe(0);
  });

  it("a rename leaves sessions alone", async () => {
    await signIn();
    await owner.db
      .update(staff)
      .set({ displayName: "Renamed" })
      .where(eq(staff.id, subject));
    expect(await sessionsLeft()).toBe(1);
  });

  it("changing the email also ends them: the old address no longer proves anything", async () => {
    await owner.db
      .update(staff)
      .set({ email: `moved-${subjectEmail}` })
      .where(eq(staff.id, subject));
    expect(await sessionsLeft()).toBe(0);
  });
});
