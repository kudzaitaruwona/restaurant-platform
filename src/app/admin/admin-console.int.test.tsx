import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  devIdentities,
  devPlatformAdmin,
  devRestaurants,
} from "@/lib/tenant/dev-identities";
import { testDatabaseSettings } from "../../../test/integration/database";
import { statusOf } from "../../../test/integration/http";
import { AdminConsole } from "./admin-console";

const session = vi.hoisted(() => ({ identity: "" }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => ({ name, value: session.identity }),
  }),
}));

// The form's useRouter needs the app router, which a static render doesn't mount.
vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: () => {} }),
}));

beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
  vi.stubEnv("DEV_AUTH_BYPASS", "1");
});
afterAll(() => vi.unstubAllEnvs());

const render = async () => {
  session.identity = devPlatformAdmin.key;
  return renderToStaticMarkup(await AdminConsole());
};

describe("the admin screen", () => {
  it("lists every restaurant, across tenants", async () => {
    const html = await render();
    for (const { name, slug } of devRestaurants) {
      expect(html).toContain(name);
      expect(html).toContain(slug);
    }
  });

  it("offers to create a restaurant, with the timezone filled in", async () => {
    const html = await render();
    expect(html).toContain('name="slug"');
    expect(html).toContain('value="Africa/Harare"');
    expect(html).toContain('value="zig_primary"');
  });

  it("doesn't offer a first owner to a restaurant that has one", async () => {
    const html = await render();
    expect(html).not.toContain(`${devRestaurants[0].id}/owner`);
  });

  it.each(devIdentities.map((identity) => [identity.key] as const))(
    "is a 403 for restaurant staff: %s",
    async (key) => {
      session.identity = key;
      expect(await statusOf(() => AdminConsole())).toBe(403);
    },
  );

  it("is a 401 with no identity", async () => {
    session.identity = "nobody";
    expect(await statusOf(() => AdminConsole())).toBe(401);
  });
});
