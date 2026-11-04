import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  adminAuthRateLimit,
  adminAuthUser,
  platformAdmins,
  staff,
  staffAuthRateLimit,
  staffAuthUser,
} from "@/db/schema";
import { getEnv } from "@/lib/env";
import { postAuth } from "../../../test/integration/auth";
import {
  openOwnerDatabase,
  testDatabaseSettings,
} from "../../../test/integration/database";
import {
  codeIn,
  installFakeServices,
} from "../../../test/integration/fake-services";
import { devIdentities } from "../tenant/dev-identities";
import { sessionCookieName } from "./cookies";
import { sessionOf } from "./index";

/**
 * The session cookie as production sets it, from Better Auth itself. If its name
 * ever parts from sessionCookieName(), everyone looks signed out, in production
 * only, which is why this runs with production settings and not the usual ones.
 */
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: Promise<unknown>) => task,
}));

const owner = openOwnerDatabase();
const tag = crypto.randomUUID();
const people = {
  staff: `cookie-${tag}@example.test`,
  admin: `cookie-admin-${tag}@example.test`,
};

let services: ReturnType<typeof installFakeServices>;

// The limiter is on in this file, in the database, keyed by IP and path, with
// a window of a minute. Rows left by an earlier run would refuse this one, and
// no other file runs with the limiter on, so these tables are this file's to empty.
const clearLimiter = async () => {
  await owner.db.delete(staffAuthRateLimit);
  await owner.db.delete(adminAuthRateLimit);
};

beforeAll(async () => {
  await clearLimiter();
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
  vi.stubEnv("DEV_AUTH_BYPASS", "");
  services = installFakeServices();
  // Read before the switch: production refuses the local database proxy, and
  // the validated environment is kept. The app reads NODE_ENV itself from here.
  getEnv();
  vi.stubEnv("NODE_ENV", "production");

  await owner.db.insert(staff).values({
    restaurantId: devIdentities[0].restaurantId,
    email: people.staff,
    displayName: "Cookie",
  });
  await owner.db.insert(platformAdmins).values({ email: people.admin });
});

afterAll(async () => {
  await clearLimiter();
  await owner.db.delete(staffAuthUser).where(eq(staffAuthUser.email, people.staff));
  await owner.db.delete(adminAuthUser).where(eq(adminAuthUser.email, people.admin));
  await owner.db.delete(staff).where(eq(staff.email, people.staff));
  await owner.db.delete(platformAdmins).where(eq(platformAdmins.email, people.admin));
  await owner.pool.end();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe.each(["staff", "admin"] as const)("the %s session cookie in production", (audience) => {
  const signIn = async () => {
    const email = people[audience];
    await postAuth(audience, "/email-otp/send-verification-otp", { email, type: "sign-in" });
    const otp = codeIn(await services.emailTo(email));
    return postAuth(audience, "/sign-in/email-otp", { email, otp });
  };

  it("has the name sessionCookieName() expects, and every attribute", async () => {
    const response = await signIn();
    const cookies = response.headers.getSetCookie();
    const session = cookies.filter((cookie) => cookie.includes("session_token"));

    expect(session).toHaveLength(1);
    const [cookie] = session;
    expect(sessionCookieName(audience)).toBe(`__Secure-${audience}.session_token`);
    expect(cookie.split("=")[0]).toBe(sessionCookieName(audience));
    expect(cookie).toMatch(/;\s*Secure/i);
    expect(cookie).toMatch(/;\s*HttpOnly/i);
    expect(cookie).toMatch(/;\s*SameSite=Lax/i);
    expect(cookie).toMatch(/;\s*Path=\//i);
    expect(cookie).toMatch(/;\s*Max-Age=2592000/i);
  });

  it("is the cookie sessionOf() finds a person by", async () => {
    const response = await signIn();
    const cookie = response.headers
      .getSetCookie()
      .find((value) => value.includes("session_token"))!
      .split(";")[0];

    expect(await sessionOf(audience, new Headers({ cookie }))).toMatchObject({
      email: people[audience],
    });
  });
});
