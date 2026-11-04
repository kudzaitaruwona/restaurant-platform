import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auditLog, restaurants, staff } from "@/db/schema";
import {
  openOwnerDatabase,
  testDatabaseSettings,
} from "../../test/integration/database";
import {
  addStaff,
  changeStaffRole,
  countOwnerLogins,
  deactivateStaff,
  listStaff,
} from "./staff-management";

const owner = openOwnerDatabase();

beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});
afterAll(async () => {
  await owner.pool.end();
  vi.unstubAllEnvs();
});

/** A restaurant of its own and its owner's context. Left behind: see last-owner.int.test.ts. */
async function newRestaurant() {
  const restaurantId = crypto.randomUUID();
  const staffId = crypto.randomUUID();
  await owner.db.insert(restaurants).values({
    id: restaurantId,
    name: "Fixture",
    slug: `staff-${restaurantId}`,
    menuToken: restaurantId,
    currencyMode: "usd_only",
  });
  await owner.db.insert(staff).values({
    id: staffId,
    restaurantId,
    email: `${staffId}@example.test`,
    displayName: "First owner",
    role: "owner",
  });
  return { restaurantId, staffId, role: "owner" as const };
}

const person = (role: "owner" | "staff" = "staff") => ({
  email: `${crypto.randomUUID()}@example.test`,
  displayName: "New person",
  role,
});

async function addColleague(
  ctx: Awaited<ReturnType<typeof newRestaurant>>,
  role: "owner" | "staff" = "staff",
) {
  const details = person(role);
  await addStaff(ctx, details);
  const team = await listStaff(ctx);
  return team.find((member) => member.email === details.email)!.id;
}

const auditEntries = (restaurantId: string, action: string) =>
  owner.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.restaurantId, restaurantId), eq(auditLog.action, action)));

describe("listing staff", () => {
  it("shows this restaurant's people, oldest first, deactivated ones included", async () => {
    const ctx = await newRestaurant();
    const leaver = await addColleague(ctx);
    await deactivateStaff(ctx, leaver);

    expect(await listStaff(ctx)).toMatchObject([
      { id: ctx.staffId, displayName: "First owner", role: "owner", active: true },
      { id: leaver, role: "staff", active: false },
    ]);
  });

  it("doesn't show another restaurant's people", async () => {
    const [mine, theirs] = [await newRestaurant(), await newRestaurant()];

    expect((await listStaff(mine)).map(({ id }) => id)).toEqual([mine.staffId]);
    expect((await listStaff(theirs)).map(({ id }) => id)).toEqual([theirs.staffId]);
  });

  it("doesn't show a platform_admin shadow row: it isn't staff to manage", async () => {
    const ctx = await newRestaurant();
    await owner.db.insert(staff).values({
      restaurantId: ctx.restaurantId,
      kind: "platform_admin",
      displayName: "Admin",
      role: "owner",
    });

    expect(await listStaff(ctx)).toHaveLength(1);
  });
});

describe("adding staff", () => {
  it("adds a staff member or an owner to the context's restaurant", async () => {
    const ctx = await newRestaurant();

    expect(await addStaff(ctx, person("staff"))).toBe("added");
    expect(await addStaff(ctx, person("owner"))).toBe("added");

    expect((await listStaff(ctx)).map(({ role }) => role).sort()).toEqual([
      "owner",
      "owner",
      "staff",
    ]);
  });

  it("writes an audit entry naming who did it, without the email", async () => {
    const ctx = await newRestaurant();
    const details = person("owner");

    await addStaff(ctx, details);

    const [created] = (await listStaff(ctx)).filter((m) => m.email === details.email);
    expect(await auditEntries(ctx.restaurantId, "staff.create")).toMatchObject([
      {
        actorType: "staff",
        actorId: ctx.staffId,
        entityType: "staff",
        entityId: created.id,
        details: { role: "owner" },
      },
    ]);
    const [entry] = await auditEntries(ctx.restaurantId, "staff.create");
    expect(JSON.stringify(entry.details)).not.toContain(details.email);
  });

  it("refuses an email that differs only in case from someone already there", async () => {
    const ctx = await newRestaurant();
    const details = person();
    await owner.db.insert(staff).values({
      restaurantId: ctx.restaurantId,
      email: details.email.toUpperCase(),
      displayName: "Entered by hand",
    });

    expect(await addStaff(ctx, details)).toBe("email_taken");
  });

  it("refuses an email already in use, in any restaurant, and writes nothing", async () => {
    const [mine, theirs] = [await newRestaurant(), await newRestaurant()];
    const details = person();
    await addStaff(theirs, details);

    expect(await addStaff(mine, details)).toBe("email_taken");

    expect(await listStaff(mine)).toHaveLength(1);
    expect(await auditEntries(mine.restaurantId, "staff.create")).toEqual([]);
  });
});

describe("deactivating staff", () => {
  it("deactivates a colleague and writes an audit entry", async () => {
    const ctx = await newRestaurant();
    const colleague = await addColleague(ctx);

    expect(await deactivateStaff(ctx, colleague)).toBe("done");

    const [row] = await owner.db.select().from(staff).where(eq(staff.id, colleague));
    expect(row.active).toBe(false);
    expect(await auditEntries(ctx.restaurantId, "staff.deactivate")).toMatchObject([
      { actorId: ctx.staffId, entityType: "staff", entityId: colleague },
    ]);
  });

  it("doesn't write a second entry for someone already gone", async () => {
    const ctx = await newRestaurant();
    const colleague = await addColleague(ctx);
    await deactivateStaff(ctx, colleague);

    expect(await deactivateStaff(ctx, colleague)).toBe("not_found");

    expect(await auditEntries(ctx.restaurantId, "staff.deactivate")).toHaveLength(1);
  });

  it("is refused for the last owner, and the audit entry goes with it", async () => {
    const ctx = await newRestaurant();

    expect(await deactivateStaff(ctx, ctx.staffId)).toBe("last_owner");

    expect(await auditEntries(ctx.restaurantId, "staff.deactivate")).toEqual([]);
  });

  it("can't reach another restaurant's staff", async () => {
    const [mine, theirs] = [await newRestaurant(), await newRestaurant()];
    const colleague = await addColleague(theirs);

    expect(await deactivateStaff(mine, colleague)).toBe("not_found");

    const [row] = await owner.db.select().from(staff).where(eq(staff.id, colleague));
    expect(row.active).toBe(true);
  });

  it("can't reach a platform_admin shadow row", async () => {
    const ctx = await newRestaurant();
    const [shadow] = await owner.db
      .insert(staff)
      .values({
        restaurantId: ctx.restaurantId,
        kind: "platform_admin",
        displayName: "Admin",
        role: "owner",
      })
      .returning({ id: staff.id });

    expect(await deactivateStaff(ctx, shadow.id)).toBe("not_found");
    expect(await changeStaffRole(ctx, shadow.id, "staff")).toBe("not_found");
  });
});

describe("changing a role", () => {
  it("promotes a colleague and records from and to", async () => {
    const ctx = await newRestaurant();
    const colleague = await addColleague(ctx);

    expect(await changeStaffRole(ctx, colleague, "owner")).toBe("done");

    expect(await auditEntries(ctx.restaurantId, "staff.role_change")).toMatchObject([
      {
        actorId: ctx.staffId,
        entityType: "staff",
        entityId: colleague,
        details: { from: "staff", to: "owner" },
      },
    ]);
  });

  it("demotes an owner while another one remains", async () => {
    const ctx = await newRestaurant();
    await addColleague(ctx, "owner");

    expect(await changeStaffRole(ctx, ctx.staffId, "staff")).toBe("done");
  });

  it("is refused for the last owner, and the audit entry goes with it", async () => {
    const ctx = await newRestaurant();

    expect(await changeStaffRole(ctx, ctx.staffId, "staff")).toBe("last_owner");

    expect(await auditEntries(ctx.restaurantId, "staff.role_change")).toEqual([]);
  });

  it("records nothing when the role doesn't change", async () => {
    const ctx = await newRestaurant();

    expect(await changeStaffRole(ctx, ctx.staffId, "owner")).toBe("done");

    expect(await auditEntries(ctx.restaurantId, "staff.role_change")).toEqual([]);
  });

  it("can't reach another restaurant's staff", async () => {
    const [mine, theirs] = [await newRestaurant(), await newRestaurant()];

    expect(await changeStaffRole(mine, theirs.staffId, "staff")).toBe("not_found");
  });
});

describe("the owner soft limit (S-26)", () => {
  it("counts active owner logins and nothing else", async () => {
    const ctx = await newRestaurant();
    await addColleague(ctx, "staff");
    await owner.db.insert(staff).values({
      restaurantId: ctx.restaurantId,
      kind: "platform_admin",
      displayName: "Admin",
      role: "owner",
    });
    const second = await addColleague(ctx, "owner");

    expect(countOwnerLogins(await listStaff(ctx))).toBe(2);

    await deactivateStaff(ctx, second);
    expect(countOwnerLogins(await listStaff(ctx))).toBe(1);
  });
});
