import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adminAuthUser,
  platformAdmins,
  staff,
  staffAuthAccount,
  staffAuthSession,
  staffAuthUser,
  staffAuthVerification,
} from "@/db/schema";
import { getAuthUrl, authUrl, cookiesFrom, postAuth, signIn } from "../../../test/integration/auth";
import {
  openOwnerDatabase,
  testDatabaseSettings,
} from "../../../test/integration/database";
import {
  codeIn,
  installFakeServices,
  linkIn,
} from "../../../test/integration/fake-services";
import { statusOf } from "../../../test/integration/http";
import { devIdentities } from "../tenant/dev-identities";

/**
 * The sign-in rules, through the real endpoints and a real database, under the
 * app's own logins: app_staff_auth and app_admin for sign-in, app_tenant for the
 * tenant context. Only Resend and Google are fake, at the network boundary.
 */
const request = vi.hoisted(() => ({ cookie: "" }));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers({ cookie: request.cookie }),
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: Promise<unknown>) => task,
}));

const owner = openOwnerDatabase();
const [aOwner, aStaff] = devIdentities;
const tag = crypto.randomUUID();

const people = {
  active: `active-${tag}@example.test`,
  deactivated: `deactivated-${tag}@example.test`,
  admin: `admin-${tag}@example.test`,
  stranger: `stranger-${tag}@example.test`,
  joinByCode: `join-code-${tag}@example.test`,
  joinByLink: `join-link-${tag}@example.test`,
  joinByGoogle: `join-google-${tag}@example.test`,
};
const activeId = crypto.randomUUID();
const deactivatedId = crypto.randomUUID();

let services: ReturnType<typeof installFakeServices>;

beforeAll(async () => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
  vi.stubEnv("DEV_AUTH_BYPASS", "");
  services = installFakeServices();
  await owner.db.insert(staff).values([
    {
      id: activeId,
      restaurantId: aOwner.restaurantId,
      email: people.active,
      displayName: "Active",
    },
    {
      id: deactivatedId,
      restaurantId: aOwner.restaurantId,
      email: people.deactivated,
      displayName: "Deactivated",
      active: false,
    },
  ]);
  await owner.db.insert(staff).values(
    [people.joinByCode, people.joinByLink, people.joinByGoogle].map((email) => ({
      restaurantId: aOwner.restaurantId,
      email,
      displayName: "Newcomer",
    })),
  );
  await owner.db.insert(platformAdmins).values({ email: people.admin });
});

afterAll(async () => {
  for (const email of Object.values(people)) {
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
  request.cookie = "";
  services.sent.length = 0;
});

const tenantContext = async () => {
  const { getTenantContext } = await import("../tenant");
  return getTenantContext();
};

/** Waits for the background send, so "nothing was sent" means something. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 150));

async function requestCode(audience: "staff" | "admin", email: string) {
  return postAuth(audience, "/email-otp/send-verification-otp", {
    email,
    type: "sign-in",
  });
}

/** What the form on each session type's sign-in page sends. */
const returning = {
  staff: { callbackURL: "/dashboard", errorCallbackURL: "/login" },
  admin: { callbackURL: "/admin", errorCallbackURL: "/login/admin" },
};

async function requestLink(
  audience: "staff" | "admin",
  email: string,
  urls: Record<string, unknown> = returning[audience],
) {
  return postAuth(audience, "/sign-in/magic-link", { email, ...urls });
}

async function googleSignIn(
  audience: "staff" | "admin",
  profile: typeof services.google.profile,
  urls: Record<string, unknown> = returning[audience],
) {
  services.google.profile = profile;
  const started = await postAuth(audience, "/sign-in/social", {
    provider: "google",
    ...urls,
  });
  const { url } = await started.json();
  const state = new URL(url).searchParams.get("state");
  return getAuthUrl(
    audience,
    authUrl(audience, `/callback/google?code=fake-code&state=${state}`),
    { cookie: cookiesFrom(started) },
  );
}

describe("email one-time code", () => {
  it("signs in an active staff member, into their own restaurant", async () => {
    request.cookie = await signIn(services, "staff", people.active);
    expect(await tenantContext()).toEqual({
      restaurantId: aOwner.restaurantId,
      staffId: activeId,
      role: "staff",
    });
  });

  it("works however the email was typed", async () => {
    request.cookie = await signIn(services, "staff", people.active);
    const shouted = people.active.toUpperCase();
    await requestCode("staff", shouted);
    const otp = codeIn(await services.emailTo(people.active));
    const response = await postAuth("staff", "/sign-in/email-otp", {
      email: shouted,
      otp,
    });
    expect(response.status).toBe(200);
  });

  it("refuses a wrong code", async () => {
    await requestCode("staff", people.active);
    const otp = codeIn(await services.emailTo(people.active));
    const wrong = otp === "000000" ? "000001" : "000000";
    const response = await postAuth("staff", "/sign-in/email-otp", {
      email: people.active,
      otp: wrong,
    });
    expect(response.status).toBe(400);
    expect(cookiesFrom(response)).toBe("");
  });

  it("a code works once", async () => {
    await requestCode("staff", people.active);
    const otp = codeIn(await services.emailTo(people.active));
    const body = { email: people.active, otp };
    expect((await postAuth("staff", "/sign-in/email-otp", body)).status).toBe(200);
    expect((await postAuth("staff", "/sign-in/email-otp", body)).status).toBe(400);
  });

  it("stops after three wrong guesses, even if the fourth is right", async () => {
    await requestCode("staff", people.active);
    const otp = codeIn(await services.emailTo(people.active));
    const wrong = otp === "000000" ? "000001" : "000000";
    for (let attempt = 0; attempt < 3; attempt++) {
      await postAuth("staff", "/sign-in/email-otp", { email: people.active, otp: wrong });
    }
    const response = await postAuth("staff", "/sign-in/email-otp", {
      email: people.active,
      otp,
    });
    expect(response.status).not.toBe(200);
  });
});

describe("magic link", () => {
  it("signs in an active staff member and lands on the dashboard", async () => {
    await requestLink("staff", people.active);
    const link = linkIn(await services.emailTo(people.active));

    const response = await getAuthUrl("staff", link);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toMatch(/\/dashboard$/);
    request.cookie = cookiesFrom(response);
    expect((await tenantContext()).staffId).toBe(activeId);
  });

  it("a link works once", async () => {
    await requestLink("staff", people.active);
    const link = linkIn(await services.emailTo(people.active));
    await getAuthUrl("staff", link);

    const response = await getAuthUrl("staff", link);

    expect(response.headers.get("location")).toMatch(/\/login\?error=/);
    expect(cookiesFrom(response)).toBe("");
  });

  it("won't redirect a signed-in user off the site", async () => {
    const response = await postAuth("staff", "/sign-in/magic-link", {
      email: people.active,
      callbackURL: "https://evil.example.test/",
    });
    expect(response.status).toBe(403);
  });
});

describe("where sign-in returns to (#116)", () => {
  const deep = "/dashboard/bookings?date=2026-11-25";
  const page = `/login?next=${encodeURIComponent(deep)}`;
  const urls = { callbackURL: deep, errorCallbackURL: page };

  it("comes back to the deep link from an emailed link", async () => {
    await requestLink("staff", people.active, urls);
    const link = linkIn(await services.emailTo(people.active));
    const response = await getAuthUrl("staff", link);
    expect(response.headers.get("location")).toBe(`http://localhost:3000${deep}`);

    // Reopened, it says so on the sign-in page, which still knows where to go.
    const again = new URL((await getAuthUrl("staff", link)).headers.get("location")!);
    expect(again.pathname).toBe("/login");
    expect(again.searchParams.get("next")).toBe(deep);
    expect(again.searchParams.get("error")).toBeTruthy();
  });

  it("comes back to the deep link from Google, and keeps it through a refusal", async () => {
    const profile = (email: string) => ({ sub: `google-${email}`, email, email_verified: true });
    const response = await googleSignIn("staff", profile(people.active), urls);
    expect(response.headers.get("location")).toMatch(/\/dashboard\/bookings\?date=2026-11-25$/);

    const refused = await googleSignIn("staff", profile(people.stranger), urls);
    const back = new URL(refused.headers.get("location")!, "http://localhost:3000");
    expect(back.pathname).toBe("/login");
    expect(back.searchParams.get("next")).toBe(deep);
  });

  it.each([
    ["staff", { callbackURL: "/admin" }],
    ["staff", { callbackURL: "/api/auth/staff/sign-out" }],
    ["staff", { callbackURL: "//evil.example.test" }],
    ["staff", { callbackURL: "/dashboard/../api/staff" }],
    ["staff", { callbackURL: "/dashboard", newUserCallbackURL: "/api/staff" }],
    ["staff", { callbackURL: "/dashboard", errorCallbackURL: "/login/admin" }],
    ["staff", { callbackURL: "/dashboard", errorCallbackURL: "/login?next=%2Fadmin" }],
    ["staff", { callbackURL: "/dashboard", errorCallbackURL: "/login?email=a%40example.test" }],
    ["staff", { callbackURL: "/dashboard", errorCallbackURL: "/api/staff" }],
    ["admin", { callbackURL: "/dashboard" }],
    ["admin", { callbackURL: "/admin", errorCallbackURL: "/login" }],
  ] as const)("refuses anything else from the %s endpoints: %j", async (audience, urls) => {
    const email = audience === "staff" ? people.active : people.admin;
    expect((await requestLink(audience, email, urls)).status).toBe(403);
    const google = await postAuth(audience, "/sign-in/social", { provider: "google", ...urls });
    expect(google.status).toBe(403);
    await settled();
    expect(services.sent).toEqual([]);
  });

  it("refuses a link whose return was rewritten, without using it up", async () => {
    await requestLink("staff", people.active);
    const link = linkIn(await services.emailTo(people.active));
    const rewritten = new URL(link);
    rewritten.searchParams.set("callbackURL", "/api/auth/staff/sign-out");
    const response = await getAuthUrl("staff", rewritten.toString());
    expect(response.status).toBe(403);
    expect(cookiesFrom(response)).toBe("");
    expect(cookiesFrom(await getAuthUrl("staff", link))).not.toBe("");
  });
});

describe("a sign-in page visited while signed in (#116)", () => {
  const visit = async (audience: "staff" | "admin", query: Record<string, string> = {}) => {
    const { SignIn } = await import("@/app/login/sign-in");
    try {
      const form = await SignIn({ audience, searchParams: Promise.resolve(query) });
      return form.props as { destination: string; page: string };
    } catch (error) {
      return String((error as { digest?: unknown }).digest).split(";")[2];
    }
  };
  const home = async () => (await import("../tenant")).signedInHome();

  it("shows the form to someone signed out, carrying the return", async () => {
    expect(await visit("staff")).toMatchObject({ destination: "/dashboard", page: "/login" });
    expect(await visit("staff", { next: "/dashboard/menu" })).toMatchObject({
      destination: "/dashboard/menu",
      page: "/login?next=%2Fdashboard%2Fmenu",
    });
    expect(await visit("staff", { next: "//evil.example.test" })).toMatchObject({
      destination: "/dashboard",
      page: "/login",
    });
    expect(await home()).toBeUndefined();
  });

  it("goes straight on, to the return or the dashboard, even from a used link", async () => {
    request.cookie = await signIn(services, "staff", people.active);
    expect(await visit("staff")).toBe("/dashboard");
    expect(await visit("staff", { next: "/dashboard/menu" })).toBe("/dashboard/menu");
    expect(await visit("staff", { error: "INVALID_TOKEN" })).toBe("/dashboard");
    expect(await visit("staff", { next: "/admin" })).toBe("/dashboard");
    expect(await home()).toBe("/dashboard");
  });

  it("still shows the form for an invite to somebody else", async () => {
    request.cookie = await signIn(services, "staff", people.active);
    expect(await visit("staff", { email: "other@example.test" })).toHaveProperty("destination");
    expect(await visit("staff", { email: people.active.toUpperCase() })).toBe("/dashboard");
  });

  it("keeps the session types apart", async () => {
    request.cookie = await signIn(services, "staff", people.active);
    expect(await visit("admin")).toMatchObject({ destination: "/admin", page: "/login/admin" });

    request.cookie = await signIn(services, "admin", people.admin);
    expect(await visit("staff")).toHaveProperty("destination");
    expect(await visit("admin", { next: "/dashboard" })).toBe("/admin");
    expect(await home()).toBe("/admin");
  });

  it("is needed before an unknown dashboard address is even a 404", async () => {
    const { default: Page } = await import("@/app/dashboard/[...unknown]/page");
    const unknown = () => Page().props.children.type();
    expect(await statusOf(unknown)).toBe(401);
    request.cookie = await signIn(services, "staff", people.active);
    expect(await statusOf(unknown)).toBe(404);
  });

  it("shows the form to someone deactivated since", async () => {
    request.cookie = await signIn(services, "staff", people.active);
    await owner.db.update(staff).set({ active: false }).where(eq(staff.id, activeId));
    try {
      expect(await visit("staff")).toHaveProperty("destination");
      expect(await home()).toBeUndefined();
    } finally {
      await owner.db.update(staff).set({ active: true }).where(eq(staff.id, activeId));
    }
  });
});

describe("Google", () => {
  const profile = (email: string) => ({
    sub: `google-${email}`,
    email,
    email_verified: true,
    name: "From Google",
  });

  it("signs in an active staff member, even one who first came by email", async () => {
    await signIn(services, "staff", people.active);

    const response = await googleSignIn("staff", profile(people.active));

    expect(response.headers.get("location")).toMatch(/\/dashboard$/);
    request.cookie = cookiesFrom(response);
    expect((await tenantContext()).staffId).toBe(activeId);
  });

  it("signs in the same person again by their Google account", async () => {
    await googleSignIn("staff", profile(people.active));
    const response = await googleSignIn("staff", profile(people.active));
    expect(response.headers.get("location")).toMatch(/\/dashboard$/);
  });

  it.each(["stranger", "deactivated"] as const)(
    "gives a %s no session and creates no account: no self sign-up",
    async (who) => {
      const response = await googleSignIn("staff", profile(people[who]));

      expect(response.headers.get("location")).toMatch(/\/login\?error=/);
      expect(cookiesFrom(response)).not.toContain("session_token");
      expect(
        await owner.db
          .select()
          .from(staffAuthUser)
          .where(eq(staffAuthUser.email, people[who])),
      ).toEqual([]);
    },
  );

  it("refuses a Google account whose email Google hasn't verified", async () => {
    const response = await googleSignIn("staff", {
      ...profile(`${aStaff.key}@dev.example.test`),
      email_verified: false,
    });
    expect(response.headers.get("location")).toMatch(/\/login\?error=/);
    expect(cookiesFrom(response)).not.toContain("session_token");
  });

  it("keeps none of Google's tokens", async () => {
    await googleSignIn("staff", profile(people.active));
    const rows = await owner.db
      .select()
      .from(staffAuthAccount)
      .where(eq(staffAuthAccount.accountId, `google-${people.active}`));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("fake-google-access-token");
  });
});

describe("joining (S-42)", () => {
  const firstSignedInAt = async (email: string) =>
    (await owner.db.select().from(staff).where(eq(staff.email, email)))[0].firstSignedInAt;

  it("is unset until someone signs in", async () => {
    expect(await firstSignedInAt(people.joinByCode)).toBeNull();
  });

  it("is set on the first sign-in by code, and kept on the next", async () => {
    await signIn(services, "staff", people.joinByCode);
    const first = await firstSignedInAt(people.joinByCode);
    expect(first).toBeInstanceOf(Date);

    await signIn(services, "staff", people.joinByCode);

    expect(await firstSignedInAt(people.joinByCode)).toEqual(first);
  });

  it("is set by a magic link", async () => {
    await requestLink("staff", people.joinByLink);
    await getAuthUrl("staff", linkIn(await services.emailTo(people.joinByLink)));
    expect(await firstSignedInAt(people.joinByLink)).toBeInstanceOf(Date);
  });

  it("is set by Google", async () => {
    await googleSignIn("staff", {
      sub: `google-${people.joinByGoogle}`,
      email: people.joinByGoogle,
      email_verified: true,
    });
    expect(await firstSignedInAt(people.joinByGoogle)).toBeInstanceOf(Date);
  });

  it("isn't set by a refused sign-in", async () => {
    await requestCode("staff", people.deactivated);
    await settled();
    expect(await firstSignedInAt(people.deactivated)).toBeNull();
  });
});

describe("who may sign in", () => {
  it.each(["stranger", "deactivated"] as const)(
    "a %s gets the same answer and no email",
    async (who) => {
      const code = await requestCode("staff", people[who]);
      const link = await requestLink("staff", people[who]);
      const real = await requestCode("staff", people.active);

      expect(code.status).toBe(real.status);
      expect(await code.json()).toEqual({ success: true });
      expect(link.status).toBe(200);
      await services.emailTo(people.active);
      await settled();
      expect(services.sent).toEqual([]);
    },
  );

  it("an existing Better Auth user who was deactivated can't get a new session", async () => {
    const subject = `again-${tag}@example.test`;
    const id = crypto.randomUUID();
    await owner.db.insert(staff).values({
      id,
      restaurantId: aOwner.restaurantId,
      email: subject,
      displayName: "Again",
    });
    await signIn(services, "staff", subject);
    await requestCode("staff", subject);
    const otp = codeIn(await services.emailTo(subject));

    await owner.db.update(staff).set({ active: false }).where(eq(staff.id, id));
    const response = await postAuth("staff", "/sign-in/email-otp", { email: subject, otp });

    expect(response.status).toBe(403);
    expect(cookiesFrom(response)).not.toContain("session_token");

    await owner.db.delete(staffAuthUser).where(eq(staffAuthUser.email, subject));
    await owner.db.delete(staff).where(eq(staff.id, id));
  });

  it("nothing else Better Auth offers is reachable", async () => {
    for (const path of [
      "/sign-up/email",
      "/sign-in/email",
      "/email-otp/reset-password",
      "/email-otp/request-password-reset",
      "/request-password-reset",
      "/reset-password",
      "/change-password",
      "/set-password",
      "/change-email",
      "/update-user",
      "/delete-user",
      "/link-social",
      "/list-accounts",
      "/list-sessions",
      "/get-access-token",
    ]) {
      const response = await postAuth("staff", path, {});
      expect([path, response.status]).toEqual([path, 404]);
    }
  });

  it("Google's ID-token shortcut is off: sign-in goes through the redirect", async () => {
    const response = await postAuth("staff", "/sign-in/social", {
      provider: "google",
      idToken: { token: "anything" },
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe("the session", () => {
  it("ends with sign-out", async () => {
    request.cookie = await signIn(services, "staff", people.active);
    const response = await postAuth("staff", "/sign-out", {}, { cookie: request.cookie });
    expect(response.status).toBe(200);
    expect(await statusOf(tenantContext)).toBe(401);
  });

  it("is a 401 with a cookie that isn't signed by us", async () => {
    const real = await signIn(services, "staff", people.active);
    request.cookie = real.replace(/\.[^.;]+(;|$)/, ".forged$1");
    expect(await statusOf(tenantContext)).toBe(401);
  });

  it("is a 401 once it has expired", async () => {
    request.cookie = await signIn(services, "staff", people.active);
    const [{ id }] = await owner.db
      .select({ id: staffAuthUser.id })
      .from(staffAuthUser)
      .where(eq(staffAuthUser.email, people.active));
    await owner.db
      .update(staffAuthSession)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(staffAuthSession.userId, id));
    expect(await statusOf(tenantContext)).toBe(401);
  });

  it("lasts 30 days from last use, not from sign-in", async () => {
    const before = Date.now();
    request.cookie = await signIn(services, "staff", people.active);
    const [{ id }] = await owner.db
      .select({ id: staffAuthUser.id })
      .from(staffAuthUser)
      .where(eq(staffAuthUser.email, people.active));
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    const rows = () =>
      owner.db
        .select({ expiresAt: staffAuthSession.expiresAt })
        .from(staffAuthSession)
        .where(eq(staffAuthSession.userId, id));

    const fresh = (await rows()).map((row) => row.expiresAt.getTime());
    expect(Math.max(...fresh)).toBeGreaterThanOrEqual(before + thirtyDays);

    // Used two days after sign-in, the expiry moves.
    await owner.db
      .update(staffAuthSession)
      .set({ expiresAt: new Date(Date.now() + thirtyDays - 2 * 86_400_000) })
      .where(eq(staffAuthSession.userId, id));
    await tenantContext();
    const used = (await rows()).map((row) => row.expiresAt.getTime());
    expect(Math.max(...used)).toBeGreaterThanOrEqual(before + thirtyDays);
  });

  it("deactivating someone ends it on their next request", async () => {
    const subject = `leaver-${tag}@example.test`;
    const id = crypto.randomUUID();
    await owner.db.insert(staff).values({
      id,
      restaurantId: aOwner.restaurantId,
      email: subject,
      displayName: "Leaver",
    });
    request.cookie = await signIn(services, "staff", subject);
    expect((await tenantContext()).staffId).toBe(id);

    await owner.db.update(staff).set({ active: false }).where(eq(staff.id, id));

    expect(await statusOf(tenantContext)).toBe(401);
    await owner.db.delete(staffAuthUser).where(eq(staffAuthUser.email, subject));
    await owner.db.delete(staff).where(eq(staff.id, id));
  });

  it("is refused even if the session outlives the trigger: the request checks too", async () => {
    const subject = `drift-${tag}@example.test`;
    const id = crypto.randomUUID();
    await owner.db.insert(staff).values({
      id,
      restaurantId: aOwner.restaurantId,
      email: subject,
      displayName: "Drift",
    });
    request.cookie = await signIn(services, "staff", subject);

    // Deleting the row fires no trigger, so the session survives it.
    await owner.db.delete(staff).where(eq(staff.id, id));

    expect(await statusOf(tenantContext)).toBe(401);
    await owner.db.delete(staffAuthUser).where(eq(staffAuthUser.email, subject));
  });
});

describe("what's stored", () => {
  it("a sign-in code isn't readable from the database", async () => {
    await requestCode("staff", people.active);
    const otp = codeIn(await services.emailTo(people.active));
    const rows = await owner.db.select().from(staffAuthVerification);
    expect(JSON.stringify(rows)).not.toContain(otp);
  });

  it("a magic-link token isn't readable from the database", async () => {
    await requestLink("staff", people.active);
    const link = linkIn(await services.emailTo(people.active));
    const token = new URL(link).searchParams.get("token")!;
    const rows = await owner.db.select().from(staffAuthVerification);
    expect(JSON.stringify(rows)).not.toContain(token);
  });
});

describe("the cookie", () => {
  it("is httpOnly and SameSite=Lax, and lasts 30 days", async () => {
    await requestCode("staff", people.active);
    const otp = codeIn(await services.emailTo(people.active));
    const response = await postAuth("staff", "/sign-in/email-otp", {
      email: people.active,
      otp,
    });
    const [cookie] = response.headers.getSetCookie();
    expect(cookie).toMatch(/^staff\.session_token=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Max-Age=2592000/i);
  });
});

describe("the platform admin", () => {
  const adminContext = async () => {
    const { getPlatformAdminContext } = await import("../tenant/platform-admin");
    return getPlatformAdminContext();
  };

  const adminId = async () => {
    const [row] = await owner.db
      .select({ id: platformAdmins.id })
      .from(platformAdmins)
      .where(eq(platformAdmins.email, people.admin));
    return row.id;
  };

  it("signs in by code", async () => {
    request.cookie = await signIn(services, "admin", people.admin);
    expect(await adminContext()).toMatchObject({ platformAdminId: await adminId() });
  });

  it("signs in by magic link", async () => {
    await requestLink("admin", people.admin);
    const link = linkIn(await services.emailTo(people.admin));
    expect(link).toContain("/api/auth/admin/");
    request.cookie = cookiesFrom(await getAuthUrl("admin", link));
    expect(await adminContext()).toMatchObject({ platformAdminId: await adminId() });
  });

  it("signs in with Google", async () => {
    const response = await googleSignIn("admin", {
      sub: `google-${people.admin}`,
      email: people.admin,
      email_verified: true,
    });
    request.cookie = cookiesFrom(response);
    expect(await adminContext()).toMatchObject({ platformAdminId: await adminId() });
  });

  it("staff can't sign in as one, by any route", async () => {
    await requestCode("admin", people.active);
    await settled();
    expect(services.sent).toEqual([]);

    const response = await googleSignIn("admin", {
      sub: `google-admin-${people.active}`,
      email: people.active,
      email_verified: true,
    });
    expect(cookiesFrom(response)).not.toContain("session_token");
  });

  it("can't use their admin sign-in as a staff one", async () => {
    await requestCode("staff", people.admin);
    await settled();
    expect(services.sent).toEqual([]);
  });

  it("no session is a 401", async () => {
    expect(await statusOf(adminContext)).toBe(401);
  });

  it("a staff session is a 403, not an admin session", async () => {
    request.cookie = await signIn(services, "staff", people.active);
    expect(await statusOf(adminContext)).toBe(403);
  });

  it("an admin session is not a staff session: a 403 until it enters a restaurant", async () => {
    request.cookie = await signIn(services, "admin", people.admin);
    expect(await statusOf(tenantContext)).toBe(403);
  });

  it("the two sessions use different cookies, so both can exist at once", async () => {
    const staffCookie = await signIn(services, "staff", people.active);
    const adminCookie = await signIn(services, "admin", people.admin);
    expect(staffCookie).toMatch(/^staff\.session_token=/);
    expect(adminCookie).toMatch(/^admin\.session_token=/);
    request.cookie = `${staffCookie}; ${adminCookie}`;
    expect((await tenantContext()).staffId).toBe(activeId);
    expect(await adminContext()).toMatchObject({ platformAdminId: await adminId() });
  });

  it("a staff session cookie renamed to the admin cookie is nobody", async () => {
    const staffCookie = await signIn(services, "staff", people.active);
    request.cookie = staffCookie.replace(/^staff\./, "admin.");
    expect(await statusOf(adminContext)).toBe(401);
  });

  it("removing a platform admin ends their session", async () => {
    const leaving = `leaving-${tag}@example.test`;
    await owner.db.insert(platformAdmins).values({ email: leaving });
    request.cookie = await signIn(services, "admin", leaving);
    await owner.db.delete(platformAdmins).where(eq(platformAdmins.email, leaving));
    expect(await statusOf(adminContext)).toBe(401);
    await owner.db.delete(adminAuthUser).where(eq(adminAuthUser.email, leaving));
  });
});
