import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  adminAuthCodeLimit,
  adminAuthUser,
  platformAdmins,
  staff,
  staffAuthCodeLimit,
  staffAuthUser,
} from "@/db/schema";
import {
  authUrl,
  cookiesFrom,
  getAuthUrl,
  postAuth,
} from "../../../test/integration/auth";
import {
  openOwnerDatabase,
  testDatabaseSettings,
} from "../../../test/integration/database";
import {
  codeIn,
  installFakeServices,
  linkIn,
} from "../../../test/integration/fake-services";
import { devIdentities } from "../tenant/dev-identities";

/**
 * The per-email ceiling on sign-in codes (S-30), through the real endpoints and
 * a real database, under sign-in's own logins: app_staff_auth for staff and
 * app_admin for the admin. Better Auth's own limiter is off here, as it is
 * everywhere outside production, so anything refused was refused by the ceiling.
 */
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: Promise<unknown>) => task,
}));

const CEILING = 20;

const owner = openOwnerDatabase();
const [aOwner] = devIdentities;
const created: string[] = [];

let services: ReturnType<typeof installFakeServices>;

beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
  vi.stubEnv("DEV_AUTH_BYPASS", "");
  services = installFakeServices();
});

afterAll(async () => {
  for (const email of created) {
    await owner.db.delete(staffAuthCodeLimit).where(eq(staffAuthCodeLimit.email, email));
    await owner.db.delete(adminAuthCodeLimit).where(eq(adminAuthCodeLimit.email, email));
    await owner.db.delete(staffAuthUser).where(eq(staffAuthUser.email, email));
    await owner.db.delete(adminAuthUser).where(eq(adminAuthUser.email, email));
    await owner.db.delete(staff).where(eq(staff.email, email));
    await owner.db.delete(platformAdmins).where(eq(platformAdmins.email, email));
  }
  await owner.pool.end();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  services.sent.length = 0;
});

/** Someone new each time, so no test inherits another's count. */
async function newStaffEmail() {
  const email = `limit-${crypto.randomUUID()}@example.test`;
  created.push(email);
  await owner.db.insert(staff).values({
    restaurantId: aOwner.restaurantId,
    email,
    displayName: "Limit",
  });
  return email;
}

async function newAdminEmail() {
  const email = `limit-admin-${crypto.randomUUID()}@example.test`;
  created.push(email);
  await owner.db.insert(platformAdmins).values({ email });
  return email;
}

function newStranger() {
  const email = `limit-stranger-${crypto.randomUUID()}@example.test`;
  created.push(email);
  return email;
}

const requestCode = (audience: "staff" | "admin", email: string) =>
  postAuth(audience, "/email-otp/send-verification-otp", { email, type: "sign-in" });

const tryCode = (audience: "staff" | "admin", email: string, otp: string) =>
  postAuth(audience, "/sign-in/email-otp", { email, otp });

async function useUpCeiling(audience: "staff" | "admin", email: string) {
  for (let attempt = 0; attempt < CEILING; attempt++) {
    const response = await requestCode(audience, email);
    expect(response.status).toBe(200);
  }
}

/** Waits for the background send, so "nothing was sent" means something. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 150));

describe("the per-email ceiling on sign-in codes", () => {
  it("stops sending codes to one email, however many addresses ask", async () => {
    const email = await newStaffEmail();
    await useUpCeiling("staff", email);
    await settled();
    services.sent.length = 0;

    const refused = await requestCode("staff", email);
    await settled();

    expect(refused.status).toBe(429);
    expect(services.sent).toEqual([]);
  });

  it("counts wrong guesses too, and then refuses even a live, right code", async () => {
    const email = await newStaffEmail();
    await requestCode("staff", email);
    for (let attempt = 2; attempt < CEILING; attempt++) {
      const response = await tryCode("staff", email, "not-it");
      expect(response.status).not.toBe(429);
    }
    await settled();
    services.sent.length = 0;
    await requestCode("staff", email);
    const otp = codeIn(await services.emailTo(email));

    const refused = await tryCode("staff", email, otp);

    expect(refused.status).toBe(429);
    expect(cookiesFrom(refused)).not.toContain("session_token");
  });

  it("applies to the admin sign-in as well", async () => {
    const email = await newAdminEmail();
    await useUpCeiling("admin", email);
    expect((await requestCode("admin", email)).status).toBe(429);
  });

  it("counts an email however it's typed", async () => {
    const email = await newStaffEmail();
    await useUpCeiling("staff", email.toUpperCase());
    expect((await requestCode("staff", email)).status).toBe(429);
  });

  it("says why, so the form can point at the other ways in", async () => {
    const email = await newStaffEmail();
    await useUpCeiling("staff", email);
    const refused = await requestCode("staff", email);
    expect(await refused.json()).toMatchObject({ code: "sign_in_codes_paused" });
  });

  it("answers an email nobody knows exactly as it answers a staff member", async () => {
    const known = await newStaffEmail();
    const unknown = newStranger();
    const answers = async (email: string) => {
      const seen = [];
      for (let attempt = 0; attempt <= CEILING; attempt++) {
        const response = await requestCode("staff", email);
        seen.push([response.status, await response.text()]);
      }
      return seen;
    };

    expect(await answers(unknown)).toEqual(await answers(known));
  });

  it("holds under a burst of parallel guesses", async () => {
    const email = await newStaffEmail();
    const responses = await Promise.all(
      Array.from({ length: CEILING * 2 }, () => tryCode("staff", email, "000000")),
    );
    const refused = responses.filter((response) => response.status === 429);
    expect(refused).toHaveLength(CEILING);
  });

  it("is shared between server instances", async () => {
    const email = await newStaffEmail();
    await useUpCeiling("staff", email);

    vi.resetModules();
    const fresh = await import("../../../test/integration/auth");
    const response = await fresh.postAuth("staff", "/email-otp/send-verification-otp", {
      email,
      type: "sign-in",
    });

    expect(response.status).toBe(429);
  });

  it("leaves the magic link working for a locked email", async () => {
    const email = await newStaffEmail();
    await useUpCeiling("staff", email);
    await settled();
    services.sent.length = 0;

    const asked = await postAuth("staff", "/sign-in/magic-link", {
      email,
      callbackURL: "/dashboard",
      errorCallbackURL: "/login",
    });
    expect(asked.status).toBe(200);
    const link = linkIn(await services.emailTo(email));

    expect(cookiesFrom(await getAuthUrl("staff", link))).toContain("session_token");
  });

  it("leaves Google working for a locked email", async () => {
    const email = await newStaffEmail();
    await useUpCeiling("staff", email);
    services.google.profile = { sub: `google-${email}`, email, email_verified: true };

    const started = await postAuth("staff", "/sign-in/social", {
      provider: "google",
      callbackURL: "/dashboard",
      errorCallbackURL: "/login",
    });
    const state = new URL((await started.json()).url).searchParams.get("state");
    const finished = await getAuthUrl(
      "staff",
      authUrl("staff", `/callback/google?code=fake-code&state=${state}`),
      { cookie: cookiesFrom(started) },
    );

    expect(cookiesFrom(finished)).toContain("session_token");
  });

  it("starts again after a code works", async () => {
    const email = await newStaffEmail();
    for (let attempt = 1; attempt < CEILING - 1; attempt++) {
      await requestCode("staff", email);
    }
    await settled();
    services.sent.length = 0;
    await requestCode("staff", email);
    const otp = codeIn(await services.emailTo(email));
    expect((await tryCode("staff", email, otp)).status).toBe(200);

    await useUpCeiling("staff", email);
  });

  it("opens again when the window is over, and not before", async () => {
    const email = await newStaffEmail();
    await useUpCeiling("staff", email);
    const ago = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000);
    const startWindow = (windowStartedAt: Date) =>
      owner.db
        .update(staffAuthCodeLimit)
        .set({ windowStartedAt })
        .where(eq(staffAuthCodeLimit.email, email));

    await startWindow(ago(23));
    expect((await requestCode("staff", email)).status).toBe(429);

    await startWindow(ago(25));
    expect((await requestCode("staff", email)).status).toBe(200);
  });

  describe("input that is not an email", () => {
    const rowsFor = async (email: string) =>
      owner.db.select().from(staffAuthCodeLimit).where(eq(staffAuthCodeLimit.email, email));

    // Better Auth's own check has no length limit, so it answers a long address
    // as it would any unknown one. What matters here is that nothing is stored
    // for it and that nothing throws.
    it("keeps no row for an address too long to be real, and does not fail", async () => {
      const email = `${crypto.randomUUID()}${"a".repeat(3000)}@example.test`;

      expect((await requestCode("staff", email)).status).not.toBe(500);
      expect((await tryCode("staff", email, "000000")).status).not.toBe(500);
      expect(await rowsFor(email)).toEqual([]);
    });

    it("leaves a string with no @ to Better Auth's 400, with no row", async () => {
      const email = `no-at-${crypto.randomUUID()}`;

      expect((await requestCode("staff", email)).status).toBe(400);
      expect(await rowsFor(email)).toEqual([]);
    });

    // Postgres can't store a NUL in text at all, so there is no row to look for.
    it("leaves a string with a NUL byte with a 400 instead of failing", async () => {
      const email = "nul\u0000byte@example.test";

      expect((await requestCode("staff", email)).status).toBe(400);
      expect((await tryCode("staff", email, "000000")).status).toBe(400);
    });

    it("still counts a real address at the longest length there is", async () => {
      const email = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(55)}.test`;
      expect(email.length).toBeLessThanOrEqual(254);
      created.push(email);

      await useUpCeiling("staff", email);

      expect((await requestCode("staff", email)).status).toBe(429);
    });
  });

  it("keeps a guess refused by the ceiling from extending the window", async () => {
    const email = await newStaffEmail();
    await useUpCeiling("staff", email);
    const [before] = await owner.db
      .select()
      .from(staffAuthCodeLimit)
      .where(eq(staffAuthCodeLimit.email, email));

    await requestCode("staff", email);

    const [after] = await owner.db
      .select()
      .from(staffAuthCodeLimit)
      .where(eq(staffAuthCodeLimit.email, email));
    expect(after.windowStartedAt).toEqual(before.windowStartedAt);
  });
});
