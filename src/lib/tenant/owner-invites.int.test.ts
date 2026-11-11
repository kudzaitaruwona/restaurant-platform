import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog, staff, staffInvites } from "@/db/schema";
import { openOwnerDatabase } from "../../../test/integration/database";
import { installFakeServices } from "../../../test/integration/fake-services";
import { inviteLink } from "../auth/email";
import { devPlatformAdmin } from "./dev-identities";
import {
  createFirstOwner,
  createRestaurant,
  listOwners,
  resendOwnerInvite,
} from "./platform-admin";

/**
 * The owner's invite (S-42): sent from inside createFirstOwner, so every caller
 * of it invites, and re-sent from the admin's owner card. Only Resend is fake.
 */
const owner = openOwnerDatabase();
const admin = { platformAdminId: devPlatformAdmin.platformAdminId };
let services: ReturnType<typeof installFakeServices>;

beforeAll(() => {
  services = installFakeServices();
});
beforeEach(() => {
  services.sent.length = 0;
  services.refusing.clear();
});
afterAll(async () => {
  // Restaurants created here stay behind: one with an owner can't lose it (S-26).
  await owner.pool.end();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function newRestaurant(name = "Mama's Kitchen") {
  const created = await createRestaurant(admin, {
    name,
    slug: `invites-${crypto.randomUUID()}`,
    timezone: "Africa/Harare",
    currencyMode: "usd_only",
  });
  if (!("id" in created)) throw new Error("No restaurant");
  return created.id;
}

const newOwner = () => ({
  email: `${crypto.randomUUID()}@example.test`,
  displayName: "Rudo Chari",
});

async function withOwner() {
  const restaurantId = await newRestaurant();
  const person = newOwner();
  const created = await createFirstOwner(admin, restaurantId, person);
  if (!("id" in created)) throw new Error("No owner");
  await services.emailTo(person.email);
  return { restaurantId, staffId: created.id, email: person.email };
}

const resends = (restaurantId: string) =>
  owner.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.restaurantId, restaurantId), eq(auditLog.action, "staff.invite_resend")));

describe("creating the first owner", () => {
  it("emails them an invite to sign in, and says it went", async () => {
    const restaurantId = await newRestaurant();
    const person = newOwner();

    const created = await createFirstOwner(admin, restaurantId, person);

    expect(created).toMatchObject({ id: expect.any(String), invited: true });
    const email = await services.emailTo(person.email);
    expect(email.subject).toBe("Mama's Kitchen is ready for you");
    expect(email.text).toContain(`\n${inviteLink("http://localhost:3000", person.email)}\n`);
  });

  it("keeps the owner when the email doesn't go, and says so", async () => {
    const restaurantId = await newRestaurant();
    const person = newOwner();
    services.refusing.add(person.email);

    const created = await createFirstOwner(admin, restaurantId, person);

    expect(created).toMatchObject({ invited: false });
    const [row] = await owner.db.select().from(staff).where(eq(staff.email, person.email));
    expect(row).toMatchObject({ role: "owner", active: true });
    expect((await listOwners(admin)).get(restaurantId)).toMatchObject([
      { email: person.email, invite: { delivered: false } },
    ]);
  });

  it("sends nothing when the owner isn't created", async () => {
    const { restaurantId } = await withOwner();

    expect(await createFirstOwner(admin, restaurantId, newOwner())).toEqual({
      problem: "has_staff",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(services.sent).toEqual([]);
  });
});

describe("the owners on /admin", () => {
  it("shows each restaurant's owners as invited, then joined once they sign in", async () => {
    const { restaurantId, staffId, email } = await withOwner();

    expect((await listOwners(admin)).get(restaurantId)).toMatchObject([
      {
        id: staffId,
        email,
        displayName: "Rudo Chari",
        firstSignedInAt: null,
        invite: { sentAt: expect.any(Date), delivered: true },
      },
    ]);

    await owner.db.update(staff).set({ firstSignedInAt: new Date() }).where(eq(staff.id, staffId));
    expect((await listOwners(admin)).get(restaurantId)).toMatchObject([
      { firstSignedInAt: expect.any(Date) },
    ]);
  });

  it("leaves a restaurant with no owner out", async () => {
    const restaurantId = await newRestaurant();
    expect((await listOwners(admin)).get(restaurantId)).toBeUndefined();
  });
});

describe("sending the owner's invite again", () => {
  it("sends it, audited as the platform admin", async () => {
    const { restaurantId, staffId, email } = await withOwner();

    expect(await resendOwnerInvite(admin, restaurantId, staffId)).toBe("sent");

    expect((await services.emailTo(email)).subject).toBe("Mama's Kitchen is ready for you");
    expect(await resends(restaurantId)).toMatchObject([
      { actorType: "platform_admin", actorId: admin.platformAdminId, entityId: staffId },
    ]);
  });

  it("reports a send that didn't go", async () => {
    const { restaurantId, staffId, email } = await withOwner();
    services.refusing.add(email);

    expect(await resendOwnerInvite(admin, restaurantId, staffId)).toBe("not_sent");
  });

  it("sends at most 3 an hour, the first included", async () => {
    const { restaurantId, staffId } = await withOwner();
    expect(await resendOwnerInvite(admin, restaurantId, staffId)).toBe("sent");
    expect(await resendOwnerInvite(admin, restaurantId, staffId)).toBe("sent");
    services.sent.length = 0;

    expect(await resendOwnerInvite(admin, restaurantId, staffId)).toBe("too_many");

    expect(services.sent).toEqual([]);
    expect(await resends(restaurantId)).toHaveLength(2);
    expect(
      await owner.db.select().from(staffInvites).where(eq(staffInvites.staffId, staffId)),
    ).toHaveLength(3);
  });

  it("refuses an owner who has signed in", async () => {
    const { restaurantId, staffId } = await withOwner();
    await owner.db.update(staff).set({ firstSignedInAt: new Date() }).where(eq(staff.id, staffId));

    expect(await resendOwnerInvite(admin, restaurantId, staffId)).toBe("joined");
  });

  it("only reaches an active owner of that restaurant", async () => {
    const mine = await withOwner();
    const theirs = await withOwner();
    const colleague = crypto.randomUUID();
    await owner.db.insert(staff).values({
      id: colleague,
      restaurantId: mine.restaurantId,
      email: `${colleague}@example.test`,
      displayName: "Staff, not owner",
    });

    for (const staffId of [theirs.staffId, colleague, crypto.randomUUID()]) {
      expect(await resendOwnerInvite(admin, mine.restaurantId, staffId)).toBe("not_found");
    }
    expect(services.sent).toEqual([]);
    expect(await resends(theirs.restaurantId)).toEqual([]);
  });

  it("refuses inside a tenant, like every platform function", async () => {
    const { restaurantId, staffId } = await withOwner();
    await expect(
      owner.db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.restaurant_id', ${restaurantId}, true)`);
        return tx.execute(
          sql`select * from platform_start_owner_invite(${admin.platformAdminId}, ${restaurantId}, ${staffId}, true)`,
        );
      }),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
  });
});
