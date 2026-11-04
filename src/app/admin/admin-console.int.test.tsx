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
  useRouter: () => ({ refresh: () => {}, replace: () => {} }),
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

  it("offers to enter every restaurant, as a plain post that can redirect", async () => {
    const html = await render();
    for (const { id } of devRestaurants) {
      expect(html).toContain(`action="/api/admin/restaurants/${id}/enter"`);
    }
    expect(html).toContain("Enter restaurant");
  });

  it("shows each restaurant's onboarding checklist, all seven items", async () => {
    const html = await render();
    for (const label of [
      "Menu entered",
      "Photos",
      "Exchange rate set",
      "Tables added",
      "QR codes printed",
      "Booking hours set",
      "Booking enabled",
    ]) {
      expect(html.split(label).length - 1).toBeGreaterThanOrEqual(devRestaurants.length);
    }
  });

  it("lets the admin tick QR codes printed, as an unticked box to start", async () => {
    const html = await render();
    expect(html).toContain("Tick as printed");
    expect(html).toContain('<input type="hidden" name="printed" value="true"/>');
  });

  it("doesn't offer a first owner to a restaurant that has one", async () => {
    const html = await render();
    expect(html).not.toContain(`${devRestaurants[0].id}/owner`);
  });

  it.each(devIdentities.map((identity) => [identity.key] as const))(
    "refuses restaurant staff with forbidden(), before any data renders: %s",
    async (key) => {
      session.identity = key;
      expect(await statusOf(() => AdminConsole())).toBe(403);
    },
  );

  it("refuses no identity with unauthorized(), before any data renders", async () => {
    session.identity = "nobody";
    expect(await statusOf(() => AdminConsole())).toBe(401);
  });
});

describe("the admin page", () => {
  const renderPage = async (bypass: string) => {
    vi.stubEnv("DEV_AUTH_BYPASS", bypass);
    vi.resetModules(); // fresh env cache
    const [{ renderToString }, { default: AdminPage }] = await Promise.all([
      import("react-dom/server"),
      import("./page"),
    ]);
    return renderToString(<AdminPage />);
  };

  it("offers sign-out on a real session", async () => {
    const html = await renderPage("");
    expect(html).toContain("Sign out");
    expect(html).not.toContain("Dev switcher");
  });

  it("offers the dev switcher instead under the bypass", async () => {
    const html = await renderPage("1");
    expect(html).toContain("Dev switcher");
    expect(html).not.toContain("Sign out");
  });
});
