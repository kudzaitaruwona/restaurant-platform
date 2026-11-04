import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  devIdentities,
  devPlatformAdmin,
  devRestaurants,
} from "@/lib/tenant/dev-identities";
import { bookings } from "@/db/schema";
import { aBooking, bookableRestaurant } from "../../../test/integration/bookings";
import { openOwnerDatabase, testDatabaseSettings } from "../../../test/integration/database";
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

describe("the booking metrics, per restaurant", () => {
  const owner = openOwnerDatabase();
  afterAll(() => owner.pool.end());

  async function restaurantWith(rows: Partial<typeof bookings.$inferInsert>[]) {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, {
      tables: rows.map(() => ({ capacity: 2 })),
    });
    await owner.db.insert(bookings).values(
      rows.map((row, index) => ({
        ...aBooking(restaurantId, tableIds[index], "2027-01-10T16:00:00Z", "2027-01-10T17:45:00Z"),
        ...row,
      })),
    );
    return `Restaurant ${restaurantId}`;
  }

  /** The text of the list item that names the restaurant. */
  const itemOf = (html: string, name: string) => {
    const item = html.split("<li").find((part) => part.includes(name))!;
    return item.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replace(/\s+/g, " ");
  };

  it("shows each restaurant its own numbers, from the same count the owner sees", async () => {
    // Made at 05:00 Harare time, before dinner opens: while staff weren't answering.
    const early = { createdAt: new Date("2026-11-05T03:00:00Z") };
    const busy = await restaurantWith([
      { ...early, status: "no_show" },
      { ...early, status: "completed" },
      { ...early, status: "completed", source: "staff" },
      { status: "completed", source: "staff" },
    ]);
    const quiet = await restaurantWith([{ status: "completed" }]);

    const html = await render();

    expect(itemOf(html, busy)).toContain("Booked online 50% 2 online, 2 added by staff");
    expect(itemOf(html, busy)).toContain("Booked while staff weren't answering 2");
    expect(itemOf(html, busy)).toContain("No-show rate 25% 1 of 4 finished bookings");
    expect(itemOf(html, quiet)).toContain("Booked online 100% 1 online, 0 added by staff");
    expect(itemOf(html, quiet)).toContain("No-show rate 0% 0 of 1 finished bookings");
  });

  it("shows a restaurant with no bookings as having none", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db);
    const empty = `Restaurant ${restaurantId}`;

    expect(itemOf(await render(), empty)).toContain("No bookings yet");
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
