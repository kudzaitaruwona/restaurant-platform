import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auditLog, restaurants, staff, staffAuthSession, staffAuthUser } from "@/db/schema";
import { signIn } from "../../../../../../test/integration/auth";
import {
  openOwnerDatabase,
  testDatabaseSettings,
} from "../../../../../../test/integration/database";
import { installFakeServices } from "../../../../../../test/integration/fake-services";
import { statusOf } from "../../../../../../test/integration/http";

/**
 * Deactivation over real sessions, through the real routes: #16's route and
 * last-owner trigger with #18's session-ending trigger, on the same UPDATE,
 * inside withTenant, as app_tenant.
 */
const browser = vi.hoisted(() => ({ cookie: "" }));

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ cookie: browser.cookie }),
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: Promise<unknown>) => task,
}));

const owner = openOwnerDatabase();
let services: ReturnType<typeof installFakeServices>;

beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
  vi.stubEnv("DEV_AUTH_BYPASS", "");
  services = installFakeServices();
});
afterAll(async () => {
  await owner.pool.end();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type Person = { staffId: string; email: string; cookie: string };

/** Someone with a real session, in the restaurant given. */
async function signedIn(restaurantId: string, role: "owner" | "staff"): Promise<Person> {
  const staffId = crypto.randomUUID();
  const email = `${staffId}@example.test`;
  await owner.db
    .insert(staff)
    .values({ id: staffId, restaurantId, email, displayName: "Fixture", role });
  return { staffId, email, cookie: await signIn(services, "staff", email) };
}

/** A restaurant of its own: left behind, because owners can't be removed (S-26). */
async function newRestaurant() {
  const restaurantId = crypto.randomUUID();
  await owner.db.insert(restaurants).values({
    id: restaurantId,
    name: "Fixture",
    slug: `sessions-${restaurantId}`,
    menuToken: restaurantId,
    currencyMode: "usd_only",
  });
  return restaurantId;
}

const as = <T,>(person: Person, call: () => Promise<T>) => {
  browser.cookie = person.cookie;
  return call();
};

const params = (staffId: string) => ({ params: Promise.resolve({ staffId }) });

const post = (path: string, fields: Record<string, string> = {}) => {
  const body = new FormData();
  for (const [name, value] of Object.entries(fields)) body.set(name, value);
  return new NextRequest(new URL(path, "http://localhost:3000"), { method: "POST", body });
};

const deactivate = async (staffId: string) =>
  (await import("./route")).POST(post(`/api/staff/${staffId}/deactivate`), params(staffId));

const changeRole = async (staffId: string, role: string) =>
  (await import("../role/route")).POST(post(`/api/staff/${staffId}/role`, { role }), params(staffId));

/** Any tenant route will do: this one reads the session and nothing else first. */
const nextRequest = async (staffId: string) =>
  (await import("../route")).GET(
    new NextRequest(new URL(`/api/staff/${staffId}`, "http://localhost:3000")),
    params(staffId),
  );

const sessionsOf = async ({ email }: Person) =>
  (
    await owner.db
      .select({ id: staffAuthSession.id })
      .from(staffAuthSession)
      .innerJoin(staffAuthUser, eq(staffAuthSession.userId, staffAuthUser.id))
      .where(eq(staffAuthUser.email, email))
  ).length;

const row = async ({ staffId }: Person) =>
  (await owner.db.select().from(staff).where(eq(staff.id, staffId)))[0];

describe("deactivating someone with a live session", () => {
  it("logs them out on their next request and leaves everyone else signed in", async () => {
    const restaurantId = await newRestaurant();
    const boss = await signedIn(restaurantId, "owner");
    const waiter = await signedIn(restaurantId, "staff");
    expect(await as(waiter, () => statusOf(() => nextRequest(waiter.staffId)))).toBe(200);

    expect((await as(boss, () => deactivate(waiter.staffId))).status).toBe(303);

    expect(await as(waiter, () => statusOf(() => nextRequest(waiter.staffId)))).toBe(401);
    expect(await sessionsOf(waiter)).toBe(0);
    expect(await sessionsOf(boss)).toBe(1);
    expect(await as(boss, () => statusOf(() => nextRequest(boss.staffId)))).toBe(200);
  });

  it("does the same for an owner, with both triggers on the one update", async () => {
    const restaurantId = await newRestaurant();
    const boss = await signedIn(restaurantId, "owner");
    const partner = await signedIn(restaurantId, "owner");

    expect((await as(boss, () => deactivate(partner.staffId))).status).toBe(303);

    expect((await row(partner)).active).toBe(false);
    expect(await as(partner, () => statusOf(() => nextRequest(partner.staffId)))).toBe(401);
    expect(await sessionsOf(partner)).toBe(0);
    const audited = await owner.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.entityId, partner.staffId));
    expect(audited).toEqual([{ action: "staff.deactivate" }]);
  });

  it("an owner deactivating themselves ends their own session", async () => {
    const restaurantId = await newRestaurant();
    const leaving = await signedIn(restaurantId, "owner");
    await signedIn(restaurantId, "owner");

    expect((await as(leaving, () => deactivate(leaving.staffId))).status).toBe(303);

    expect(await as(leaving, () => statusOf(() => nextRequest(leaving.staffId)))).toBe(401);
  });
});

describe("when the last-owner rule refuses", () => {
  it("the last owner stays active and signed in: the session delete rolls back too", async () => {
    const restaurantId = await newRestaurant();
    const boss = await signedIn(restaurantId, "owner");

    expect((await as(boss, () => deactivate(boss.staffId))).status).toBe(409);

    expect((await row(boss)).active).toBe(true);
    expect(await sessionsOf(boss)).toBe(1);
    expect(await as(boss, () => statusOf(() => nextRequest(boss.staffId)))).toBe(200);
  });

  it("demoting the last owner leaves them an owner and signed in", async () => {
    const restaurantId = await newRestaurant();
    const boss = await signedIn(restaurantId, "owner");

    expect((await as(boss, () => changeRole(boss.staffId, "staff"))).status).toBe(409);

    expect((await row(boss)).role).toBe("owner");
    expect(await sessionsOf(boss)).toBe(1);
  });
});

describe("a role change", () => {
  it("doesn't end the session, and the new role applies on the next request", async () => {
    const restaurantId = await newRestaurant();
    const boss = await signedIn(restaurantId, "owner");
    const waiter = await signedIn(restaurantId, "staff");

    expect((await as(boss, () => changeRole(waiter.staffId, "owner"))).status).toBe(303);

    expect(await sessionsOf(waiter)).toBe(1);
    expect((await as(waiter, () => changeRole(boss.staffId, "staff"))).status).toBe(303);
  });
});
