import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testDatabaseSettings } from "../../../../../test/integration/database";
import { statusOf } from "../../../../../test/integration/http";
import {
  DEV_IDENTITY_COOKIE,
  devIdentities,
  devPlatformAdmin,
} from "@/lib/tenant/dev-identities";

const jar = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      jar.has(name) ? { name, value: jar.get(name) } : undefined,
    set: (name: string, value: string) => jar.set(name, value),
  }),
}));

async function pick(identity: string) {
  vi.resetModules(); // fresh env cache per test
  const { POST } = await import("./route");
  const body = new FormData();
  body.set("identity", identity);
  return POST(
    new Request("http://localhost:3000/api/dev/identity", {
      method: "POST",
      body,
    }),
  );
}

describe("POST /api/dev/identity (the dev switcher)", () => {
  beforeEach(() => {
    jar.clear();
    vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
    vi.stubEnv("DEV_AUTH_BYPASS", "1");
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(devIdentities.map((identity) => [identity.key, identity] as const))(
    "switches getTenantContext() to %s",
    async (key, identity) => {
      expect((await pick(key)).status).toBe(303);

      const { getTenantContext } = await import("@/lib/tenant");
      expect(await getTenantContext()).toEqual({
        restaurantId: identity.restaurantId,
        staffId: identity.staffId,
        role: identity.role,
      });
    },
  );

  it("switches to the platform admin and lands on the admin screen", async () => {
    const response = await pick(devPlatformAdmin.key);
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/admin");

    const { getPlatformAdminContext } = await import(
      "@/lib/tenant/platform-admin"
    );
    expect(await getPlatformAdminContext()).toEqual({
      platformAdminId: devPlatformAdmin.platformAdminId,
    });
  });

  it("refuses anything but a seeded identity", async () => {
    expect((await pick("nobody")).status).toBe(400);
    expect(jar.has(DEV_IDENTITY_COOKIE)).toBe(false);
  });

  it("isn't there without the bypass", async () => {
    vi.stubEnv("DEV_AUTH_BYPASS", "");
    expect(await statusOf(() => pick("a-owner"))).toBe(404);
    expect(jar.has(DEV_IDENTITY_COOKIE)).toBe(false);
  });

  it("isn't there in production, even with the variable set", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(await statusOf(() => pick("a-owner"))).toBe(404);
    expect(jar.has(DEV_IDENTITY_COOKIE)).toBe(false);
  });
});
