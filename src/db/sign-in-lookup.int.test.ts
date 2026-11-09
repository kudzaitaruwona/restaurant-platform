import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  openAdminDatabase,
  openOwnerDatabase,
  openStaffAuthDatabase,
} from "../../test/integration/database";
import { devIdentities } from "../lib/tenant/dev-identities";
import { platformAdmins, staff } from "./schema";

/**
 * Sign-in happens before any tenant is known, so RLS rightly hides `staff`.
 * These two SECURITY DEFINER functions are the only way past it, each for its
 * own audience's login: the staff one for staff sign-in's, the admin one for the
 * admin's (S-28). staff-auth-role.int.test.ts proves app_tenant can call neither.
 */
const staffLogin = openStaffAuthDatabase();
const adminLogin = openAdminDatabase();
const owner = openOwnerDatabase();

const [aOwner] = devIdentities;
const inactive = crypto.randomUUID();
const admin = crypto.randomUUID();
const tag = crypto.randomUUID();
const inactiveEmail = `inactive-${tag}@example.test`;
const adminEmail = `admin-${tag}@example.test`;

beforeAll(async () => {
  await owner.db.insert(staff).values([
    {
      id: inactive,
      restaurantId: aOwner.restaurantId,
      email: inactiveEmail,
      displayName: "Gone",
      active: false,
    },
  ]);
  await owner.db.insert(platformAdmins).values({ id: admin, email: adminEmail });
});

afterAll(async () => {
  await owner.db.delete(staff).where(eq(staff.id, inactive));
  await owner.db.delete(platformAdmins).where(eq(platformAdmins.id, admin));
  await Promise.all([staffLogin.pool.end(), adminLogin.pool.end(), owner.pool.end()]);
});

const staffLookup = async (email: string) =>
  (
    await staffLogin.db.execute(
      sql`select * from staff_identity_by_email(${email})`,
    )
  ).rows;

const adminLookup = async (email: string) =>
  (
    await adminLogin.db.execute(
      sql`select platform_admin_id_by_email(${email}) as id`,
    )
  ).rows[0].id;

describe("staff_identity_by_email, as app_staff_auth with no tenant set", () => {
  it("finds an active staff member and returns only what a session needs", async () => {
    expect(await staffLookup(`${aOwner.key}@dev.example.test`)).toEqual([
      {
        restaurant_id: aOwner.restaurantId,
        staff_id: aOwner.staffId,
        role: "owner",
      },
    ]);
  });

  it("ignores case, because people don't type their email the same way twice", async () => {
    expect(
      await staffLookup(`${aOwner.key}@DEV.Example.test`.toUpperCase()),
    ).toHaveLength(1);
  });

  it("finds nobody for an unknown email", async () => {
    expect(await staffLookup(`nobody-${tag}@example.test`)).toEqual([]);
  });

  it("refuses a deactivated staff member", async () => {
    expect(await staffLookup(inactiveEmail)).toEqual([]);
  });

  it("can never find a shadow row, because Postgres refuses one an email", async () => {
    await expect(
      owner.db.insert(staff).values({
        restaurantId: aOwner.restaurantId,
        kind: "platform_admin",
        role: "owner",
        email: `shadow-${tag}@example.test`,
        displayName: "Shadow",
      }),
    ).rejects.toMatchObject({ cause: { constraint: "staff_shadow_row" } });
  });

  it("doesn't treat email as a pattern", async () => {
    expect(await staffLookup("%")).toEqual([]);
  });
});

describe("platform_admin_id_by_email, as app_admin", () => {
  it("finds a platform admin, ignoring case", async () => {
    expect(await adminLookup(adminEmail.toUpperCase())).toBe(admin);
  });

  it("finds nobody for staff or an unknown email", async () => {
    expect(await adminLookup(`${aOwner.key}@dev.example.test`)).toBeNull();
    expect(await adminLookup(`nobody-${tag}@example.test`)).toBeNull();
  });
});

describe("an email is one person, whatever its case", () => {
  it("the same email can't belong to staff at two restaurants", async () => {
    const [, , bOwner] = devIdentities;
    await expect(
      owner.db.insert(staff).values({
        restaurantId: bOwner.restaurantId,
        email: `${aOwner.key}@dev.example.test`,
        displayName: "Twin",
      }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("nor can it get past that by changing case", async () => {
    const [, , bOwner] = devIdentities;
    await expect(
      owner.db.insert(staff).values({
        restaurantId: bOwner.restaurantId,
        email: `${aOwner.key}@dev.example.test`.toUpperCase(),
        displayName: "Twin",
      }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("platform admins are held to the same rule", async () => {
    await expect(
      owner.db.insert(platformAdmins).values({ email: adminEmail.toUpperCase() }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });
});

describe("how the functions are locked down", () => {
  const functions = ["staff_identity_by_email", "platform_admin_id_by_email"];

  it.each(functions)("%s is SECURITY DEFINER with a fixed search_path", async (name) => {
    const { rows } = await owner.db.execute(sql`
      select prosecdef, proconfig from pg_proc
      where proname = ${name} and pronamespace = 'public'::regnamespace
    `);
    expect(rows).toEqual([
      { prosecdef: true, proconfig: ["search_path=pg_catalog, pg_temp"] },
    ]);
  });

  it.each(functions)("%s can be executed by one role and not by PUBLIC", async (name) => {
    const { rows } = await owner.db.execute(sql`
      select coalesce(grantee.rolname, 'PUBLIC') as grantee
      from pg_proc p
      cross join lateral aclexplode(p.proacl) acl
      left join pg_roles grantee on grantee.oid = acl.grantee
      where p.proname = ${name} and p.pronamespace = 'public'::regnamespace
        and acl.privilege_type = 'EXECUTE'
        and acl.grantee <> p.proowner
    `);
    expect(rows).toEqual([
      { grantee: name.startsWith("platform_") ? "app_admin" : "app_staff_auth" },
    ]);
  });
});
