import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adminAuthEntry,
  adminAuthSession,
  adminAuthUser,
  auditLog,
  platformAdmins,
  restaurants,
  staff,
  staffAuthUser,
} from "@/db/schema";
import { postAuth, signIn } from "../../../test/integration/auth";
import {
  openOwnerDatabase,
  openTestDatabase,
  testDatabaseSettings,
} from "../../../test/integration/database";
import { installFakeServices } from "../../../test/integration/fake-services";
import { statusOf } from "../../../test/integration/http";
import { getTenantContext } from "./index";
import {
  enterRestaurant,
  getPlatformAdminContext,
  leaveRestaurant,
} from "./platform-admin";

/**
 * Entering a restaurant, on real sessions with the bypass off. An admin of this
 * file's own, because another file's cleanup could otherwise end its sessions.
 * `next/headers` is faked only to hand the seam what the browser would send.
 */
const browser = vi.hoisted(() => ({ cookie: "", extraHeaders: {} as Record<string, string> }));

vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({ cookie: browser.cookie, ...browser.extraHeaders }),
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: Promise<unknown>) => task,
}));

const owner = openOwnerDatabase();
const app = openTestDatabase();

const tag = crypto.randomUUID();
const adminId = crypto.randomUUID();
const adminEmail = `entering-admin-${tag}@example.test`;

let services: ReturnType<typeof installFakeServices>;
const adminSession = () => signIn(services, "admin", adminEmail);

/** A restaurant of its own, with one owner, per test. */
async function newRestaurant() {
  const id = crypto.randomUUID();
  await owner.db.insert(restaurants).values({
    id,
    name: `Entered ${id}`,
    slug: `entered-${id}`,
    menuToken: `entered-${id}`,
    currencyMode: "usd_only",
  });
  const email = `owner-${id}@example.test`;
  await owner.db
    .insert(staff)
    .values({ restaurantId: id, email, displayName: "Real owner", role: "owner" });
  return { id, ownerEmail: email };
}

const asAdmin = () => getPlatformAdminContext();

async function enter(restaurantId: string) {
  const result = await enterRestaurant(await asAdmin(), restaurantId);
  expect(result).toHaveProperty("id");
}

const shadowRows = (restaurantId: string) =>
  owner.db
    .select()
    .from(staff)
    .where(and(eq(staff.restaurantId, restaurantId), eq(staff.kind, "platform_admin")));

const auditOf = (restaurantId: string) =>
  owner.db.select().from(auditLog).where(eq(auditLog.restaurantId, restaurantId));

beforeAll(async () => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
  vi.stubEnv("DEV_AUTH_BYPASS", "");
  services = installFakeServices();
  await owner.db.insert(platformAdmins).values({ id: adminId, email: adminEmail });
});

beforeEach(async () => {
  browser.cookie = await adminSession();
  browser.extraHeaders = {};
});

afterAll(async () => {
  await owner.db.delete(adminAuthUser).where(eq(adminAuthUser.email, adminEmail));
  await owner.db.delete(platformAdmins).where(eq(platformAdmins.id, adminId));
  await Promise.all([owner.pool.end(), app.pool.end()]);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the first entry", () => {
  it("creates a shadow row: platform_admin, an owner, no email", async () => {
    const { id } = await newRestaurant();

    await enter(id);

    expect(await shadowRows(id)).toMatchObject([
      { kind: "platform_admin", role: "owner", email: null, active: true },
    ]);
  });

  it("happens exactly once: later entries reuse the row", async () => {
    const { id } = await newRestaurant();

    await enter(id);
    const [first] = await shadowRows(id);
    await leaveRestaurant(await asAdmin());
    await enter(id);

    expect(await shadowRows(id)).toEqual([first]);
  });

  it("happens exactly once when two admin sessions enter at the same moment", async () => {
    const { id } = await newRestaurant();
    const contexts = [];
    while (contexts.length < 4) {
      browser.cookie = await adminSession();
      contexts.push(await asAdmin());
    }

    const results = await Promise.all(
      contexts.map((context) => enterRestaurant(context, id)),
    );

    const rows = await shadowRows(id);
    expect(rows).toHaveLength(1);
    expect(results).toEqual(contexts.map(() => ({ id: rows[0].id })));
  });

  it("is one statement: refused, it leaves no shadow row and no entry behind", async () => {
    const missing = crypto.randomUUID();
    const admin = await asAdmin();

    expect(await enterRestaurant(admin, missing)).toEqual({ problem: "no_restaurant" });

    expect(await shadowRows(missing)).toEqual([]);
    expect(await statusOf(getTenantContext)).toBe(403);
  });
});

describe("inside the restaurant", () => {
  it("getTenantContext() returns the shadow row, as an owner of that restaurant", async () => {
    const { id } = await newRestaurant();
    await enter(id);
    const [shadow] = await shadowRows(id);

    expect(await getTenantContext()).toEqual({
      restaurantId: id,
      staffId: shadow.id,
      role: "owner",
      platformAdminId: adminId,
    });
  });

  it("the admin is still the admin: the admin routes keep working", async () => {
    const { id } = await newRestaurant();
    await enter(id);
    expect((await asAdmin()).platformAdminId).toBe(adminId);
  });

  it("entering another restaurant moves the session there, and only there", async () => {
    const [first, second] = [await newRestaurant(), await newRestaurant()];
    await enter(first.id);
    await enter(second.id);

    expect(await getTenantContext()).toMatchObject({ restaurantId: second.id });
  });

  it("wins over a staff session in the same browser, and leaving gives it back", async () => {
    const { id } = await newRestaurant();
    const elsewhere = await newRestaurant();
    const staffCookie = await signIn(services, "staff", elsewhere.ownerEmail);
    browser.cookie = `${browser.cookie}; ${staffCookie}`;

    expect(await getTenantContext()).toMatchObject({ restaurantId: elsewhere.id });

    await enter(id);
    expect(await getTenantContext()).toMatchObject({
      restaurantId: id,
      platformAdminId: adminId,
    });

    await leaveRestaurant(await asAdmin());
    const context = await getTenantContext();
    expect(context).toMatchObject({ restaurantId: elsewhere.id });
    expect(context).not.toHaveProperty("platformAdminId");

    await owner.db
      .delete(staffAuthUser)
      .where(eq(staffAuthUser.email, elsewhere.ownerEmail));
  });
});

describe("what chooses the tenant", () => {
  it("isn't anything the request sends", async () => {
    const [entered, other] = [await newRestaurant(), await newRestaurant()];
    await enter(entered.id);

    browser.cookie = `${browser.cookie}; restaurantId=${other.id}; entered_restaurant_id=${other.id}`;
    browser.extraHeaders = { "x-restaurant-id": other.id };

    expect(await getTenantContext()).toMatchObject({ restaurantId: entered.id });
  });

  it("a cookie naming a restaurant gets an admin who hasn't entered nothing", async () => {
    const { id } = await newRestaurant();
    browser.cookie = `${browser.cookie}; restaurantId=${id}; entered_restaurant_id=${id}`;

    expect(await statusOf(getTenantContext)).toBe(403);
    expect(await shadowRows(id)).toEqual([]);
  });

  it("a session cookie someone has edited is nobody", async () => {
    const { id } = await newRestaurant();
    await enter(id);

    browser.cookie = browser.cookie.replace(/=(.)/, (_, first) =>
      `=${first === "a" ? "b" : "a"}`,
    );

    expect(await statusOf(getTenantContext)).toBe(401);
  });

  it("is per session: the admin's other browser isn't in the restaurant", async () => {
    const { id } = await newRestaurant();
    await enter(id);

    browser.cookie = await adminSession();

    expect(await statusOf(getTenantContext)).toBe(403);
  });
});

describe("dropping out", () => {
  const entered = async () => {
    const { id } = await newRestaurant();
    await enter(id);
    return id;
  };

  const entriesFor = async (restaurantId: string) =>
    owner.db
      .select()
      .from(adminAuthEntry)
      .where(eq(adminAuthEntry.enteredRestaurantId, restaurantId));

  it("leaving is a 403 again, and the shadow row stays for next time", async () => {
    const id = await entered();

    await leaveRestaurant(await asAdmin());

    expect(await statusOf(getTenantContext)).toBe(403);
    expect(await entriesFor(id)).toEqual([]);
    expect(await shadowRows(id)).toHaveLength(1);
  });

  it("leaving when nowhere is nothing, and audits nothing", async () => {
    await expect(leaveRestaurant(await asAdmin())).resolves.toBeUndefined();
  });

  it("signing out ends it", async () => {
    const id = await entered();
    const { cookie } = browser;

    const response = await postAuth("admin", "/sign-out", {}, { cookie });

    expect(response.ok).toBe(true);
    expect(await statusOf(getTenantContext)).toBe(401);
    expect(await entriesFor(id)).toEqual([]);
  });

  it("a session past its expiry ends it, though the row is still there", async () => {
    const id = await entered();
    const [{ sessionId }] = await entriesFor(id);

    await owner.db
      .update(adminAuthSession)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(adminAuthSession.id, sessionId));

    expect(await statusOf(getTenantContext)).toBe(401);
  });

  it("removing the session row ends it", async () => {
    const id = await entered();
    const [{ sessionId }] = await entriesFor(id);

    await owner.db.delete(adminAuthSession).where(eq(adminAuthSession.id, sessionId));

    expect(await statusOf(getTenantContext)).toBe(401);
    expect(await entriesFor(id)).toEqual([]);
  });

  it("no longer being a platform admin ends it on the next request", async () => {
    const leavingId = crypto.randomUUID();
    const leavingEmail = `leaving-admin-${tag}@example.test`;
    await owner.db.insert(platformAdmins).values({ id: leavingId, email: leavingEmail });
    browser.cookie = await signIn(services, "admin", leavingEmail);
    await entered();

    await owner.db.delete(platformAdmins).where(eq(platformAdmins.id, leavingId));

    expect(await statusOf(getTenantContext)).toBe(401);
    await owner.db.delete(adminAuthUser).where(eq(adminAuthUser.email, leavingEmail));
  });

  it("losing the shadow row ends it: an entry can't outlive what it points at", async () => {
    const id = await entered();

    await owner.db
      .delete(staff)
      .where(and(eq(staff.restaurantId, id), eq(staff.kind, "platform_admin")));

    expect(await statusOf(getTenantContext)).toBe(403);
  });
});

describe("what gets audited", () => {
  it("every entry and leaving, as the platform admin, with platform_admins.id", async () => {
    const { id } = await newRestaurant();

    await enter(id);
    await leaveRestaurant(await asAdmin());
    await enter(id);

    const entries = await auditOf(id);
    expect(entries.map(({ action }) => action).sort()).toEqual([
      "restaurant.enter",
      "restaurant.enter",
      "restaurant.leave",
    ]);
    for (const entry of entries) {
      expect(entry).toMatchObject({
        actorType: "platform_admin",
        actorId: adminId,
        entityType: "restaurant",
        entityId: id,
      });
    }
  });

  it("never records the shadow row as the actor (S-29)", async () => {
    const { id } = await newRestaurant();
    await enter(id);
    const [shadow] = await shadowRows(id);

    const entries = await auditOf(id);
    expect(entries.map(({ actorId }) => actorId)).not.toContain(shadow.id);
  });
});

describe("the shadow row in Postgres", () => {
  const shadowOf = async () => {
    const { id } = await newRestaurant();
    await enter(id);
    const [shadow] = await shadowRows(id);
    return { restaurantId: id, shadowId: shadow.id };
  };

  it("can't be given an email, so sign-in can never find it", async () => {
    const { shadowId } = await shadowOf();
    await expect(
      owner.db.execute(sql`update staff set email = 'x@example.test' where id = ${shadowId}`),
    ).rejects.toMatchObject({ cause: { constraint: "staff_shadow_row" } });
  });

  it("can't be demoted or deactivated", async () => {
    const { shadowId } = await shadowOf();
    for (const change of [sql`role = 'staff'`, sql`active = false`]) {
      await expect(
        owner.db.execute(sql`update staff set ${change} where id = ${shadowId}`),
      ).rejects.toMatchObject({ cause: { constraint: "staff_shadow_row" } });
    }
  });

  it("can't be doubled: a second one for the same restaurant is refused", async () => {
    const { restaurantId } = await shadowOf();
    await expect(
      owner.db.insert(staff).values({
        restaurantId,
        kind: "platform_admin",
        role: "owner",
        displayName: "Second shadow",
      }),
    ).rejects.toMatchObject({ cause: { constraint: "staff_one_shadow_per_restaurant" } });
  });

  it("gives a restaurant no owner: the first owner can still be created", async () => {
    const id = crypto.randomUUID();
    await owner.db.insert(restaurants).values({
      id,
      name: "No owner yet",
      slug: `entered-${id}`,
      menuToken: `entered-${id}`,
      currencyMode: "usd_only",
    });
    await enter(id);

    const { createFirstOwner } = await import("./platform-admin");
    const result = await createFirstOwner(await asAdmin(), id, {
      email: `first-${id}@example.test`,
      displayName: "First owner",
    });

    expect(result).toHaveProperty("id");
  });

  it("isn't an owner to the last-owner rule (S-26)", async () => {
    const { id } = await newRestaurant();
    await enter(id);

    await expect(
      app.db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.restaurant_id', ${id}, true)`);
        return tx.execute(sql`update staff set active = false where kind = 'staff'`);
      }),
    ).rejects.toMatchObject({ cause: { constraint: "staff_last_active_owner" } });
  });
});
