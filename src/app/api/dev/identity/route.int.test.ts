import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testDatabaseSettings } from "../../../../../test/integration/database";
import { statusOf } from "../../../../../test/integration/http";
import { FORM_FETCH_HEADER } from "@/lib/form-response";
import {
  DEV_IDENTITY_COOKIE,
  devIdentities,
  devPlatformAdmin,
  devRestaurants,
} from "@/lib/tenant/dev-identities";

const jar = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
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
      sessionId: devPlatformAdmin.sessionId,
    });
  });

  // The only file that enters as the dev admin, or asks whether the dev admin has
  // entered: there's one seeded session, so anywhere else would race these.
  describe("entering a restaurant under the bypass", () => {
    const [restaurant] = devRestaurants;

    // Whatever a test did, the next one starts outside.
    afterEach(async () => {
      const { leaveRestaurant } = await import("@/lib/tenant/platform-admin");
      await leaveRestaurant(devPlatformAdmin);
    });

    async function enter(headers?: HeadersInit) {
      await pick(devPlatformAdmin.key);
      const { POST } = await import(
        "@/app/api/admin/restaurants/[restaurantId]/enter/route"
      );
      return POST(
        new NextRequest(
          new URL(`/api/admin/restaurants/${restaurant.id}/enter`, "http://localhost:3000"),
          { method: "POST", headers },
        ),
        { params: Promise.resolve({ restaurantId: restaurant.id }) },
      );
    }

    it("is a 403 from getTenantContext() until the admin enters one", async () => {
      await pick(devPlatformAdmin.key);

      const { getTenantContext } = await import("@/lib/tenant");
      expect(await statusOf(getTenantContext)).toBe(403);
    });

    it("lands on the dashboard, in that restaurant, with the cookie still only a key", async () => {
      const response = await enter();

      expect(response.status).toBe(303);
      expect(response.headers.get("Location")).toBe("/dashboard");
      expect(jar.get(DEV_IDENTITY_COOKIE)).toBe(devPlatformAdmin.key);

      const { getTenantContext } = await import("@/lib/tenant");
      expect(await getTenantContext()).toMatchObject({
        restaurantId: restaurant.id,
        role: "owner",
        platformAdminId: devPlatformAdmin.platformAdminId,
      });
    });

    // Plain forms, which return the 303 themselves: a 204 is no page at all.
    it("entering and leaving redirect whoever posts", async () => {
      const headers = { [FORM_FETCH_HEADER]: "1" };

      const entered = await enter(headers);
      expect(entered.status).toBe(303);
      expect(entered.headers.get("Location")).toBe("/dashboard");

      const { POST } = await import("@/app/api/admin/leave/route");
      const left = await POST();
      expect(left.status).toBe(303);
      expect(left.headers.get("Location")).toBe("/admin");
    });

    it("drops the admin out when they switch to someone else", async () => {
      await enter();

      await pick(devIdentities[0].key);
      await pick(devPlatformAdmin.key);

      const { getTenantContext } = await import("@/lib/tenant");
      expect(await statusOf(getTenantContext)).toBe(403);
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
