import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog, restaurants, staff, staffInvites } from "@/db/schema";
import {
  openOwnerDatabase,
  openTestDatabase,
  testDatabaseSettings,
} from "../../test/integration/database";
import { installFakeServices } from "../../test/integration/fake-services";
import { inviteLink } from "./auth/email";
import {
  addStaff,
  changeStaffRole,
  countOwnerLogins,
  deactivateStaff,
  INVITES_PER_HOUR,
  listStaff,
  resendInvite,
} from "./staff-management";

const owner = openOwnerDatabase();
const app = openTestDatabase();
let services: ReturnType<typeof installFakeServices>;

beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
  services = installFakeServices();
});
beforeEach(() => {
  services.sent.length = 0;
  services.refusing.clear();
});
afterAll(async () => {
  await owner.pool.end();
  await app.pool.end();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
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

describe("invites (S-42)", () => {
  const appUrl = "http://localhost:3000";

  it("emails the new person an invite naming the restaurant and who added them", async () => {
    const ctx = await newRestaurant();
    const details = person("staff");

    expect(await addStaff(ctx, details)).toBe("added");

    const email = await services.emailTo(details.email);
    expect(email.subject).toBe("First owner added you to Fixture");
    expect(email.text).toContain(`\n${inviteLink(appUrl, details.email)}\n`);
    expect(services.sent).toEqual([]);
  });

  it("names the platform, not the shadow row, when an entered admin adds someone", async () => {
    const ctx = await newRestaurant();
    const details = person("staff");

    await addStaff({ ...ctx, platformAdminId: crypto.randomUUID() }, details);

    expect((await services.emailTo(details.email)).subject).toBe(
      "The restaurant-platform team added you to Fixture",
    );
  });

  it("shows the person as invited, and when, until they sign in", async () => {
    const ctx = await newRestaurant();
    const details = person("staff");
    const before = Date.now();
    await addStaff(ctx, details);

    const member = (await listStaff(ctx)).find((m) => m.email === details.email)!;
    expect(member.firstSignedInAt).toBeNull();
    expect(member.invite).toMatchObject({ delivered: true });
    expect(member.invite!.sentAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("keeps the person when the email doesn't go, and shows that it didn't", async () => {
    const ctx = await newRestaurant();
    const details = person("staff");
    services.refusing.add(details.email);

    expect(await addStaff(ctx, details)).toBe("added");

    const member = (await listStaff(ctx)).find((m) => m.email === details.email)!;
    expect(member).toMatchObject({ active: true, invite: { delivered: false } });
    expect(await auditEntries(ctx.restaurantId, "staff.create")).toHaveLength(1);
  });

  it("sends nothing when the person isn't added", async () => {
    const [mine, theirs] = [await newRestaurant(), await newRestaurant()];
    const details = person();
    await addStaff(theirs, details);
    await services.emailTo(details.email);

    expect(await addStaff(mine, details)).toBe("email_taken");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(services.sent).toEqual([]);
  });

  describe("sending it again", () => {
    it("sends another, audited as a resend by whoever asked", async () => {
      const ctx = await newRestaurant();
      const colleague = await addColleague(ctx);
      const [{ email }] = await owner.db.select().from(staff).where(eq(staff.id, colleague));
      await services.emailTo(email!);

      expect(await resendInvite(ctx, colleague)).toBe("sent");

      expect((await services.emailTo(email!)).subject).toBe("First owner added you to Fixture");
      expect(await auditEntries(ctx.restaurantId, "staff.invite_resend")).toMatchObject([
        { actorType: "staff", actorId: ctx.staffId, entityType: "staff", entityId: colleague },
      ]);
    });

    it("reports a send that didn't go, and records it", async () => {
      const ctx = await newRestaurant();
      const colleague = await addColleague(ctx);
      const [{ email }] = await owner.db.select().from(staff).where(eq(staff.id, colleague));
      services.refusing.add(email!);

      expect(await resendInvite(ctx, colleague)).toBe("not_sent");

      const member = (await listStaff(ctx)).find((m) => m.id === colleague)!;
      expect(member.invite).toMatchObject({ delivered: false });
    });

    it(`sends at most ${INVITES_PER_HOUR} an hour to one person, the first included`, async () => {
      const ctx = await newRestaurant();
      const colleague = await addColleague(ctx);
      for (let i = 1; i < INVITES_PER_HOUR; i++) {
        expect(await resendInvite(ctx, colleague)).toBe("sent");
      }
      services.sent.length = 0;

      expect(await resendInvite(ctx, colleague)).toBe("too_many");

      expect(services.sent).toEqual([]);
      expect(await auditEntries(ctx.restaurantId, "staff.invite_resend")).toHaveLength(
        INVITES_PER_HOUR - 1,
      );
    });

    it("lets an hour-old invite fall out of the count", async () => {
      const ctx = await newRestaurant();
      const colleague = await addColleague(ctx);
      for (let i = 1; i < INVITES_PER_HOUR; i++) await resendInvite(ctx, colleague);
      await owner.db
        .update(staffInvites)
        .set({ sentAt: sql`now() - interval '61 minutes'` })
        .where(eq(staffInvites.staffId, colleague));

      expect(await resendInvite(ctx, colleague)).toBe("sent");
    });

    it("refuses someone who has already signed in", async () => {
      const ctx = await newRestaurant();
      const colleague = await addColleague(ctx);
      await owner.db
        .update(staff)
        .set({ firstSignedInAt: new Date() })
        .where(eq(staff.id, colleague));

      expect(await resendInvite(ctx, colleague)).toBe("joined");
    });

    it("can't reach a deactivated person or another restaurant's", async () => {
      const [mine, theirs] = [await newRestaurant(), await newRestaurant()];
      const leaver = await addColleague(mine);
      await deactivateStaff(mine, leaver);
      const stranger = await addColleague(theirs);
      services.sent.length = 0;

      expect(await resendInvite(mine, leaver)).toBe("not_found");
      expect(await resendInvite(mine, stranger)).toBe("not_found");

      expect(services.sent).toEqual([]);
      expect(await auditEntries(theirs.restaurantId, "staff.invite_resend")).toEqual([]);
    });
  });

  describe("what app_tenant can't do", () => {
    const asTenant = (restaurantId: string, statement: ReturnType<typeof sql>) =>
      app.db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.restaurant_id', ${restaurantId}, true)`);
        return tx.execute(statement);
      });

    it("can't mark someone as signed in, on insert or update, or clear it", async () => {
      const ctx = await newRestaurant();
      await owner.db
        .update(staff)
        .set({ firstSignedInAt: new Date() })
        .where(eq(staff.id, ctx.staffId));

      for (const statement of [
        sql`update staff set first_signed_in_at = now() where restaurant_id = ${ctx.restaurantId}`,
        sql`update staff set first_signed_in_at = null where id = ${ctx.staffId}`,
        sql`insert into staff (restaurant_id, email, display_name, first_signed_in_at)
            values (${ctx.restaurantId}, ${`${crypto.randomUUID()}@example.test`}, 'Planted', now())`,
      ]) {
        await expect(asTenant(ctx.restaurantId, statement)).rejects.toMatchObject({
          cause: { code: "42501" },
        });
      }
    });

    it("can't get round the hourly limit by deleting or backdating invites", async () => {
      const ctx = await newRestaurant();
      const colleague = await addColleague(ctx);

      for (const statement of [
        sql`delete from staff_invites where staff_id = ${colleague}`,
        sql`update staff_invites set sent_at = now() - interval '2 hours' where staff_id = ${colleague}`,
      ]) {
        await expect(asTenant(ctx.restaurantId, statement)).rejects.toMatchObject({
          cause: { code: "42501" },
        });
      }
    });

    it("can't insert past the limit itself: Postgres holds it", async () => {
      const ctx = await newRestaurant();
      const colleague = await addColleague(ctx);
      const insert = sql`insert into staff_invites (restaurant_id, staff_id)
        values (${ctx.restaurantId}, ${colleague})`;
      for (let i = 1; i < INVITES_PER_HOUR; i++) await asTenant(ctx.restaurantId, insert);

      await expect(asTenant(ctx.restaurantId, insert)).rejects.toMatchObject({
        cause: { code: "PA002" },
      });
    });
  });
});
