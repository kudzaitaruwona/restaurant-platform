import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auditLog, restaurants, staff } from "@/db/schema";
import { openOwnerDatabase, testDatabaseSettings } from "../../test/integration/database";
import { importStaff, previewStaffImport } from "./staff-import";
import { listStaff } from "./staff-management";

const owner = openOwnerDatabase();

beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});
afterAll(async () => {
  await owner.pool.end();
  vi.unstubAllEnvs();
});

/** A restaurant and its owner's context. Left behind: see last-owner.int.test.ts. */
async function newRestaurant({ withOwner = true } = {}) {
  const restaurantId = crypto.randomUUID();
  const staffId = crypto.randomUUID();
  await owner.db.insert(restaurants).values({
    id: restaurantId,
    name: "Fixture",
    slug: `staff-import-${restaurantId}`,
    menuToken: restaurantId,
    currencyMode: "usd_only",
  });
  if (withOwner) {
    await owner.db.insert(staff).values({
      id: staffId,
      restaurantId,
      email: `${staffId}@example.test`,
      displayName: "First owner",
      role: "owner",
    });
  }
  return { restaurantId, staffId, role: "owner" as const };
}

const email = () => `${crypto.randomUUID()}@example.test`;

const report = <T,>(result: T) => {
  if (result && typeof result === "object" && "error" in result) {
    throw new Error(String((result as { error: string }).error));
  }
  return result as Exclude<T, { error: string }>;
};

describe("previewStaffImport", () => {
  it("checks each row with the staff form's rules and writes nothing", async () => {
    const tenant = await newRestaurant();
    const repeated = email();
    const csv = [
      "email,name,role",
      `${repeated},Tendai,staff`,
      `${repeated.toUpperCase()},Tendai again,`,
      `${tenant.staffId}@example.test,Me,owner`, // already on the staff
      "not-an-email,Rudo,staff",
      `${email()},,staff`,
      `${email()},Chipo,manager`,
      `${email()},Farai,`, // blank role is staff
    ].join("\n");

    const preview = report(await previewStaffImport(tenant, csv));

    expect(preview.rows.map((row) => row.problems)).toEqual([
      [],
      [`${repeated} is already in this file, on line 2.`],
      [`${tenant.staffId}@example.test is already on your staff.`],
      ["Enter a valid email address."],
      ["Enter a name, up to 200 characters."],
      ["Choose owner or staff."],
      [],
    ]);
    expect(await listStaff(tenant)).toHaveLength(1);
  });

  it("needs an owner row before any staff row when the restaurant has no owner yet", async () => {
    const tenant = await newRestaurant({ withOwner: false });
    const csv = `email,name,role\n${email()},Staff first,staff\n${email()},The owner,owner\n${email()},Staff after,staff`;

    const preview = report(await previewStaffImport(tenant, csv));

    expect(preview.rows.map((row) => row.problems)).toEqual([
      ["This restaurant has no owner yet, so add its owner first: put an owner row above this one."],
      [],
      [],
    ]);
  });
});

describe("importStaff", () => {
  it("adds each valid person through the single form's addStaff, audited each as staff.create", async () => {
    const tenant = await newRestaurant();
    const tendai = email();
    const rudo = email();

    const result = report(
      await importStaff(tenant, `email,name,role\n${tendai.toUpperCase()},Tendai,staff\n${rudo},Rudo,owner\nbad,Bad,staff`),
    );

    expect(result).toMatchObject({ imported: 2 });
    expect(result.rows.map((row) => row.problems.length)).toEqual([0, 0, 1]);
    const team = await listStaff(tenant);
    expect(team.map(({ email, displayName, role }) => ({ email, displayName, role }))).toEqual([
      { email: `${tenant.staffId}@example.test`, displayName: "First owner", role: "owner" },
      { email: tendai, displayName: "Tendai", role: "staff" },
      { email: rudo, displayName: "Rudo", role: "owner" },
    ]);
    const audits = await owner.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.restaurantId, tenant.restaurantId)));
    expect(audits).toEqual([{ action: "staff.create" }, { action: "staff.create" }]);
  });

  it("reports an email another restaurant already has, and adds the rest", async () => {
    const elsewhere = await newRestaurant();
    const tenant = await newRestaurant();
    const taken = `${elsewhere.staffId}@example.test`;
    const fresh = email();

    const result = report(await importStaff(tenant, `email,name\n${taken},Taken\n${fresh},Fresh`));

    expect(result.imported).toBe(1);
    expect(result.rows[0].problems).toEqual([
      "That email can't be added: it already has a staff login.",
    ]);
    expect((await listStaff(tenant)).map((member) => member.email)).toContain(fresh);
  });

  it("adds the owner first when the file starts with one, in a restaurant with none", async () => {
    const tenant = await newRestaurant({ withOwner: false });

    const result = report(
      await importStaff(tenant, `email,name,role\n${email()},Owner,owner\n${email()},Staff,staff`),
    );

    expect(result.imported).toBe(2);
  });
});
