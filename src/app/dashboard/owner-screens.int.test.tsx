import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as addCategory } from "@/app/api/menu/categories/route";
import { POST as setRate } from "@/app/api/menu/exchange-rate/route";
import { POST as addItem } from "@/app/api/menu/items/route";
import { POST as saveSettings } from "@/app/api/restaurant/route";
import { POST as deactivate } from "@/app/api/staff/[staffId]/deactivate/route";
import { POST as changeRole } from "@/app/api/staff/[staffId]/role/route";
import { POST as addStaff } from "@/app/api/staff/route";
import { auditLog, categories, exchangeRates, restaurants, staff } from "@/db/schema";
import { FORM_FETCH_HEADER } from "@/lib/form-response";
import type { TenantContext } from "@/lib/tenant";
import {
  openOwnerDatabase,
  testDatabaseSettings,
} from "../../../test/integration/database";
import { statusOf } from "../../../test/integration/http";
import { Dashboard } from "./dashboard";
import { MenuScreen } from "./menu/menu-screen";
import { SettingsScreen } from "./settings/settings-screen";
import { StaffScreen } from "./staff/staff-screen";

/**
 * The owner's screens and the routes behind them, on a restaurant of their own.
 * Faked: who's asking (access.int.test.ts covers the real seam, but its seeded
 * restaurants can't be changed) and the App Router context the client form
 * expects.
 */
const session = vi.hoisted(() => ({ tenant: undefined as unknown }));

vi.mock("@/lib/tenant", async (original) => ({
  ...(await original<typeof import("@/lib/tenant")>()),
  getTenantContext: async () => session.tenant as TenantContext,
}));

vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh() {} }),
}));

// Only a real request has a cache to revalidate.
vi.mock("next/cache", () => ({ revalidateTag: () => {} }));

const owner = openOwnerDatabase();
beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});
afterAll(async () => {
  await owner.pool.end();
  vi.unstubAllEnvs();
});

let tenant: TenantContext;

beforeEach(async () => {
  const restaurantId = crypto.randomUUID();
  const staffId = crypto.randomUUID();
  await owner.db.insert(restaurants).values({
    id: restaurantId,
    name: "Mama's Kitchen",
    slug: `screens-${restaurantId}`,
    menuToken: restaurantId,
    currencyMode: "usd_only",
    wifiName: "Mamas Guest",
    wifiPassword: "sadza-and-stew",
  });
  await owner.db.insert(staff).values({
    id: staffId,
    restaurantId,
    email: `${staffId}@example.test`,
    displayName: "First Owner",
    role: "owner",
  });
  tenant = { restaurantId, staffId, role: "owner" };
  session.tenant = tenant;
});

const post = (
  path: string,
  fields: Record<string, string> = {},
  headers: Record<string, string> = {},
) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return new NextRequest(new URL(path, "http://localhost:3000"), {
    method: "POST",
    body,
    headers,
  });
};

const params = (staffId: string) => ({ params: Promise.resolve({ staffId }) });

const screen = async (Screen: () => Promise<React.ReactElement>) =>
  renderToStaticMarkup(await Screen());

const newPerson = (role: string) => ({
  email: `${crypto.randomUUID()}@example.test`,
  displayName: `New ${role}`,
  role,
});

const newCategory = async (name = "Mains") => {
  const [{ id }] = await owner.db
    .insert(categories)
    .values({ restaurantId: tenant.restaurantId, name })
    .returning({ id: categories.id });
  return id;
};

const item = (categoryId: string) => ({
  name: "Beef stew",
  description: "With sadza",
  priceUsd: "8.50",
  categoryId,
});

const settings = {
  name: "Mama's Kitchen",
  contactPhone: "",
  wifiName: "",
  wifiPassword: "",
  currencyMode: "usd_only",
  timezone: "Africa/Harare",
};

describe("how a saved form is answered", () => {
  const madeBy = {
    plainPost: {},
    actionForm: { [FORM_FETCH_HEADER]: "1" },
  };

  /** Each route on a colleague of its own, since a change can't be made twice. */
  const colleague = async () => {
    const person = newPerson("staff");
    await addStaff(post("/api/staff", person));
    const [{ id }] = await owner.db
      .select({ id: staff.id })
      .from(staff)
      .where(eq(staff.email, person.email));
    return id;
  };

  const routes: [string, string, (headers: Record<string, string>) => Promise<Response>][] = [
    [
      "POST /api/restaurant",
      "/dashboard/settings",
      (headers) => saveSettings(post("/api/restaurant", settings, headers)),
    ],
    [
      "POST /api/staff",
      "/dashboard/staff",
      (headers) => addStaff(post("/api/staff", newPerson("staff"), headers)),
    ],
    [
      "POST /api/staff/[staffId]/role",
      "/dashboard/staff",
      async (headers) => {
        const id = await colleague();
        return changeRole(
          post(`/api/staff/${id}/role`, { role: "owner" }, headers),
          params(id),
        );
      },
    ],
    [
      "POST /api/staff/[staffId]/deactivate",
      "/dashboard/staff",
      async (headers) => {
        const id = await colleague();
        return deactivate(post(`/api/staff/${id}/deactivate`, {}, headers), params(id));
      },
    ],
    [
      "POST /api/menu/categories",
      "/dashboard/menu",
      (headers) =>
        addCategory(post("/api/menu/categories", { name: "Mains" }, headers)),
    ],
    [
      "POST /api/menu/items",
      "/dashboard/menu",
      async (headers) => {
        const categoryId = await newCategory();
        return addItem(post("/api/menu/items", item(categoryId), headers));
      },
    ],
    [
      "POST /api/menu/exchange-rate",
      "/dashboard/menu",
      (headers) =>
        setRate(post("/api/menu/exchange-rate", { usdToZig: "26.2" }, headers)),
    ],
  ];

  it.each(routes)("%s redirects a plain post", async (_route, page, send) => {
    const response = await send(madeBy.plainPost);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(page);
  });

  it.each(routes)("%s tells the form without a redirect", async (_route, _page, send) => {
    const response = await send(madeBy.actionForm);
    expect(response.status).toBe(204);
    expect(response.headers.get("location")).toBeNull();
  });

  it("still refuses a bad form with its reason", async () => {
    const response = await saveSettings(
      post("/api/restaurant", { ...settings, timezone: "Mars/Olympus" }, madeBy.actionForm),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expect.any(String) });
  });
});

describe("/dashboard/menu", () => {
  it("shows the menu an owner has built, and where customers see it", async () => {
    const categoryId = await newCategory("Mains");
    await addItem(post("/api/menu/items", item(categoryId)));

    const html = await screen(MenuScreen);

    expect(html).toContain("Mains");
    expect(html).toContain("Beef stew");
    expect(html).toContain("With sadza");
    expect(html).toContain("$8.50");
    expect(html).toContain(`href="/m/${tenant.restaurantId}"`);
  });

  it("posts to the routes behind it", async () => {
    await newCategory();
    const html = await screen(MenuScreen);
    expect(html).toContain('action="/api/menu/categories"');
    expect(html).toContain('action="/api/menu/items"');
  });

  it("offers this restaurant's categories in the item form", async () => {
    const categoryId = await newCategory("Mains");
    const html = await screen(MenuScreen);
    expect(html).toContain(`<option value="${categoryId}">Mains</option>`);
  });

  it("asks for a category first, since an item needs one", async () => {
    const html = await screen(MenuScreen);
    expect(html).toContain("Add a category first");
    expect(html).not.toContain('action="/api/menu/items"');
  });

  it("offers an owner the sold-out toggle on each item", async () => {
    const categoryId = await newCategory("Mains");
    await addItem(post("/api/menu/items", item(categoryId)));

    const html = await screen(MenuScreen);

    expect(html).toMatch(/action="\/api\/menu\/items\/[0-9a-f-]+\/availability"/);
    expect(html).toContain("Mark sold out");
  });

  it("lets staff see the list and mark items sold out, but not add to it", async () => {
    const categoryId = await newCategory("Mains");
    await addItem(post("/api/menu/items", item(categoryId)));
    session.tenant = { ...tenant, role: "staff" };

    const html = await screen(MenuScreen);

    expect(html).toContain("Beef stew");
    expect(html).toContain("Mark sold out");
    expect(html).toMatch(/action="\/api\/menu\/items\/[0-9a-f-]+\/availability"/);
    expect(html).not.toContain('action="/api/menu/categories"');
    expect(html).not.toContain('action="/api/menu/items"');
    expect(html).not.toContain("Add an item");
  });
});

describe("the menu routes", () => {
  it("refuse an unusable price with a reason, and save nothing", async () => {
    const categoryId = await newCategory();

    const response = await addItem(
      post("/api/menu/items", { ...item(categoryId), priceUsd: "free" }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expect.any(String) });
    expect(await screen(MenuScreen)).not.toContain("Beef stew");
  });

  it("refuse a blank category name with a reason", async () => {
    const response = await addCategory(post("/api/menu/categories", { name: " " }));
    expect(response.status).toBe(400);
  });
});

describe("the exchange rate", () => {
  const savedRates = () =>
    owner.db
      .select()
      .from(exchangeRates)
      .where(eq(exchangeRates.restaurantId, tenant.restaurantId));

  /** Backdates the newest rate, as if it had been set that long ago. */
  const setDaysAgo = (days: number) =>
    owner.db
      .update(exchangeRates)
      .set({ createdAt: new Date(Date.now() - days * 24 * 3_600_000) })
      .where(eq(exchangeRates.restaurantId, tenant.restaurantId));

  it("is set from the menu screen, which posts to its route", async () => {
    await newCategory();
    const html = await screen(MenuScreen);
    expect(html).toContain('action="/api/menu/exchange-rate"');
    expect(html).toContain("1 USD = ZiG");
    expect(html).toContain("No exchange rate is set");
  });

  it("saves a new row and an audit entry for each change", async () => {
    await setRate(post("/api/menu/exchange-rate", { usdToZig: "26.2" }));
    await setRate(post("/api/menu/exchange-rate", { usdToZig: "27" }));

    expect((await savedRates()).map((row) => row.usdToZig).sort()).toEqual(["26.2", "27"]);
    const entries = await owner.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.restaurantId, tenant.restaurantId));
    expect(entries.filter((entry) => entry.action === "exchange_rate.set")).toHaveLength(2);
  });

  it.each(["", "0", "-5", "abc", "NaN"])(
    "refuses the rate %j with a reason, and saves nothing",
    async (usdToZig) => {
      const response = await setRate(post("/api/menu/exchange-rate", { usdToZig }));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await savedRates()).toEqual([]);
    },
  );

  it("shows on the menu screen, with the item's calculated ZiG price", async () => {
    const categoryId = await newCategory();
    await addItem(post("/api/menu/items", item(categoryId)));
    await setRate(post("/api/menu/exchange-rate", { usdToZig: "26.2" }));

    const html = await screen(MenuScreen);

    expect(html).toContain("1 USD = ZiG 26.2, last updated today");
    expect(html).toContain("ZiG 230 (calculated)");
    expect(html).not.toContain("more than 7 days old");
  });

  it("shows on the dashboard: how old it is, with no warning yet", async () => {
    await setRate(post("/api/menu/exchange-rate", { usdToZig: "26.2" }));
    await setDaysAgo(6);

    const html = await screen(Dashboard);

    expect(html).toContain("1 USD = ZiG 26.2, last updated 6 days ago");
    expect(html).not.toContain("more than 7 days old");
  });

  it("warns on the dashboard and the menu screen once it is more than 7 days old", async () => {
    await setRate(post("/api/menu/exchange-rate", { usdToZig: "26.2" }));
    await setDaysAgo(8);

    for (const Screen of [Dashboard, MenuScreen]) {
      expect(await screen(Screen)).toContain("more than 7 days old");
    }
  });

  it("warns on the dashboard when none was ever set", async () => {
    expect(await screen(Dashboard)).toContain("No exchange rate is set");
  });

  it("is kept off a staff member's dashboard", async () => {
    await setRate(post("/api/menu/exchange-rate", { usdToZig: "26.2" }));
    session.tenant = { ...tenant, role: "staff" };

    expect(await screen(Dashboard)).not.toContain("1 USD = ZiG");
  });

  it("takes an item with only a ZiG price", async () => {
    const categoryId = await newCategory();

    const response = await addItem(
      post("/api/menu/items", { ...item(categoryId), priceUsd: "", priceZig: "210" }),
    );

    expect(response.status).toBe(303);
    expect(await screen(MenuScreen)).toContain("ZiG 210");
  });

  it("refuses an item with no price at all, with a reason", async () => {
    const categoryId = await newCategory();

    const response = await addItem(
      post("/api/menu/items", { ...item(categoryId), priceUsd: "", priceZig: "" }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Enter a USD price, a ZiG price, or both.",
    });
  });

  it("offers the ZiG field to the item form", async () => {
    await newCategory();
    expect(await screen(MenuScreen)).toContain('name="priceZig"');
  });
});

describe("/dashboard/staff", () => {
  it("lists the team with what an owner can do to each member", async () => {
    await addStaff(post("/api/staff", newPerson("staff")));

    const html = await screen(StaffScreen);

    expect(html).toContain("First Owner");
    expect(html).toContain("New staff");
    expect(html).toContain(`/api/staff/${tenant.staffId}/deactivate`);
    expect(html).toContain(`/api/staff/${tenant.staffId}/role`);
  });

  it("marks a deactivated member and offers nothing further", async () => {
    const person = newPerson("staff");
    await addStaff(post("/api/staff", person));
    const [{ id }] = await owner.db
      .select({ id: staff.id })
      .from(staff)
      .where(eq(staff.email, person.email));
    await deactivate(post(`/api/staff/${id}/deactivate`), params(id));

    const html = await screen(StaffScreen);

    expect(html).toContain("Deactivated");
    expect(html).not.toContain(`/api/staff/${id}/deactivate`);
    expect(html).not.toContain(`/api/staff/${id}/role`);
  });

  it("refuses staff with forbidden(), before any data renders", async () => {
    session.tenant = { ...tenant, role: "staff" };
    expect(await statusOf(() => StaffScreen())).toBe(403);
  });

  describe("the soft-limit notice", () => {
    const notice = "goes over";
    const overLimit = "more than the one";

    it("warns before adding a second owner, and says nothing is over yet", async () => {
      const html = await screen(StaffScreen);

      expect(html).toContain(notice);
      expect(html).not.toContain(overLimit);
    });

    it("shows once a second owner is added, and the add isn't blocked", async () => {
      const response = await addStaff(post("/api/staff", newPerson("owner")));

      expect(response.status).toBe(303);
      expect(await screen(StaffScreen)).toContain(overLimit);
    });

    it("shows when a colleague is promoted to a second owner", async () => {
      const person = newPerson("staff");
      await addStaff(post("/api/staff", person));
      const [{ id }] = await owner.db
        .select({ id: staff.id })
        .from(staff)
        .where(eq(staff.email, person.email));

      await changeRole(post(`/api/staff/${id}/role`, { role: "owner" }), params(id));

      expect(await screen(StaffScreen)).toContain(overLimit);
    });

    it("doesn't count staff logins", async () => {
      await addStaff(post("/api/staff", newPerson("staff")));
      await addStaff(post("/api/staff", newPerson("staff")));

      expect(await screen(StaffScreen)).not.toContain(overLimit);
    });

    it("doesn't count a platform_admin shadow row", async () => {
      await owner.db.insert(staff).values({
        restaurantId: tenant.restaurantId,
        kind: "platform_admin",
        displayName: "Shadow",
        role: "owner",
      });

      const html = await screen(StaffScreen);

      expect(html).not.toContain(overLimit);
      expect(html).not.toContain("Shadow");
    });
  });
});

describe("the staff routes", () => {
  it("refuses to remove the last owner with a reason, not an error", async () => {
    for (const response of [
      await deactivate(post("/deactivate"), params(tenant.staffId)),
      await changeRole(post("/role", { role: "staff" }), params(tenant.staffId)),
    ]) {
      expect(response.status).toBe(409);
      expect((await response.json()).error).toContain("at least one active owner");
    }
  });

  it("explains a refused form", async () => {
    const response = await addStaff(post("/api/staff", { ...newPerson("staff"), email: "nope" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Enter a valid email address." });
  });

  it("explains an email that's taken", async () => {
    const person = newPerson("staff");
    await addStaff(post("/api/staff", person));

    expect((await addStaff(post("/api/staff", person))).status).toBe(409);
  });

  it("refuses a role that doesn't exist", async () => {
    const response = await changeRole(post("/role", { role: "admin" }), params(tenant.staffId));
    expect(response.status).toBe(400);
  });

  it("is a 404 for someone already deactivated", async () => {
    const person = newPerson("staff");
    await addStaff(post("/api/staff", person));
    const [{ id }] = await owner.db
      .select({ id: staff.id })
      .from(staff)
      .where(eq(staff.email, person.email));
    await deactivate(post("/deactivate"), params(id));

    expect(await statusOf(() => deactivate(post("/deactivate"), params(id)))).toBe(404);
  });
});

describe("/dashboard/settings", () => {
  it("shows the current settings for editing", async () => {
    const html = await screen(SettingsScreen);

    expect(html).toContain('value="Mama&#x27;s Kitchen"');
    expect(html).toContain('value="Mamas Guest"');
    expect(html).toContain('action="/api/restaurant"');
    expect(html).toMatch(/<option[^>]*value="usd_only"[^>]*selected/);
    expect(html).toMatch(/<option[^>]*value="Africa\/Harare"[^>]*selected/);
  });

  it("saves what the form posts", async () => {
    const response = await saveSettings(
      post("/api/restaurant", {
        ...settings,
        name: "Mama's Place",
        contactPhone: "+263 77 123 4567",
        timezone: "Africa/Johannesburg",
      }),
    );

    expect(response.status).toBe(303);
    const [row] = await owner.db
      .select()
      .from(restaurants)
      .where(eq(restaurants.id, tenant.restaurantId));
    expect(row).toMatchObject({
      name: "Mama's Place",
      contactPhone: "+263771234567",
      timezone: "Africa/Johannesburg",
    });
  });

  it.each([
    [{ contactPhone: "0771234567" }, "international format"],
    [{ timezone: "Mars/Olympus" }, "timezone"],
    // Known to Node's ICU, not to this Postgres, where AT TIME ZONE would fail.
    [{ timezone: "Asia/Calcutta" }, "timezone"],
    [{ currencyMode: "gold" }, "currency"],
    [{ name: "" }, "name"],
  ])("refuses %j with a reason and saves nothing", async (bad, reason) => {
    const response = await saveSettings(post("/api/restaurant", { ...settings, ...bad }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain(reason);
    const [row] = await owner.db
      .select()
      .from(restaurants)
      .where(eq(restaurants.id, tenant.restaurantId));
    expect(row.wifiName).toBe("Mamas Guest");
  });

  // The last two are stored names one side has dropped: saving must still work.
  describe.each(["US/Eastern", "Asia/Kolkata", "Etc/GMT+2", "Asia/Calcutta", "Mars/Olympus"])(
    "with a stored timezone the list leaves out: %s",
    (timezone) => {
      beforeEach(async () => {
        await owner.db
          .update(restaurants)
          .set({ timezone })
          .where(eq(restaurants.id, tenant.restaurantId));
      });

      /** What a browser submits: the selected option, or else the first. */
      const submittedTimezone = (html: string) => {
        const [select] = /<select[^>]*name="timezone"[\s\S]*?<\/select>/.exec(html)!;
        const options = [...select.matchAll(/<option[^>]*>/g)].map(([tag]) => tag);
        const chosen = options.find((tag) => / selected/.test(tag)) ?? options[0];
        return /value="([^"]+)"/.exec(chosen)![1];
      };

      it("shows it as the selected option", async () => {
        expect(submittedTimezone(await screen(SettingsScreen))).toBe(timezone);
      });

      it("survives a save that only changes the Wi-Fi", async () => {
        const html = await screen(SettingsScreen);

        const response = await saveSettings(
          post("/api/restaurant", {
            ...settings,
            wifiName: "New Wi-Fi",
            timezone: submittedTimezone(html),
          }),
        );

        expect(response.status).toBe(303);
        const [row] = await owner.db
          .select()
          .from(restaurants)
          .where(eq(restaurants.id, tenant.restaurantId));
        expect(row).toMatchObject({ wifiName: "New Wi-Fi", timezone });
      });
    },
  );

  it("refuses staff with forbidden(), so they never receive the Wi-Fi password", async () => {
    session.tenant = { ...tenant, role: "staff" };
    expect(await statusOf(() => SettingsScreen())).toBe(403);
  });
});
