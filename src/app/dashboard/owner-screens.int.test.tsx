import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as addCategory } from "@/app/api/menu/categories/route";
import { POST as addItem } from "@/app/api/menu/items/route";
import { POST as saveSettings } from "@/app/api/restaurant/route";
import { POST as deactivate } from "@/app/api/staff/[staffId]/deactivate/route";
import { POST as changeRole } from "@/app/api/staff/[staffId]/role/route";
import { POST as addStaff } from "@/app/api/staff/route";
import { POST as archive } from "@/app/api/tables/[tableId]/archive/route";
import { POST as move } from "@/app/api/tables/[tableId]/move/route";
import { POST as regenerateTable } from "@/app/api/tables/[tableId]/regenerate/route";
import { POST as editTable } from "@/app/api/tables/[tableId]/route";
import { POST as addTable } from "@/app/api/tables/route";
import { categories, diningTables, restaurants, staff } from "@/db/schema";
import { getEnv } from "@/lib/env";
import { FORM_FETCH_HEADER } from "@/lib/form-response";
import { menuCodeUrl, qrSvg, tableCodeUrl } from "@/lib/qr-code";
import type { TenantContext } from "@/lib/tenant";
import {
  openOwnerDatabase,
  testDatabaseSettings,
} from "../../../test/integration/database";
import { statusOf } from "../../../test/integration/http";
import { MenuScreen } from "./menu/menu-screen";
import { TablesScreen } from "./tables/tables-screen";
import { PrintSheet } from "./tables/print/print-sheet";
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

  const newTableId = async () => {
    const label = crypto.randomUUID().slice(0, 8);
    await addTable(post("/api/tables", { label, capacity: "4" }));
    return tableId(label);
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
      "POST /api/tables",
      "/dashboard/tables",
      (headers) => addTable(post("/api/tables", { label: "7", capacity: "4" }, headers)),
    ],
    [
      "POST /api/tables/[tableId]",
      "/dashboard/tables",
      async (headers) => {
        const id = await newTableId();
        return editTable(
          post(`/api/tables/${id}`, { label: "Edited", capacity: "2", bookable: "true" }, headers),
          tableParams(id),
        );
      },
    ],
    [
      "POST /api/tables/[tableId]/move",
      "/dashboard/tables",
      async (headers) => {
        const id = await newTableId();
        return move(post(`/api/tables/${id}/move`, { direction: "down" }, headers), tableParams(id));
      },
    ],
    [
      "POST /api/tables/[tableId]/archive",
      "/dashboard/tables",
      async (headers) => {
        const id = await newTableId();
        return archive(post(`/api/tables/${id}/archive`, {}, headers), tableParams(id));
      },
    ],
    [
      "POST /api/tables/[tableId]/regenerate",
      "/dashboard/tables",
      async (headers) => {
        const id = await tableIdOf("7");
        return regenerateTable(post(`/api/tables/${id}/regenerate`, {}, headers), tableParams(id));
      },
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

  it("refuses staff with forbidden(), before any data renders", async () => {
    session.tenant = { ...tenant, role: "staff" };
    expect(await statusOf(() => MenuScreen())).toBe(403);
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

const newTable = (label = "7", capacity = "4") =>
  addTable(post("/api/tables", { label, capacity }));

const tableParams = (tableId: string) => ({ params: Promise.resolve({ tableId }) });

/** The table with this label, added first if the restaurant has none by then. */
async function tableIdOf(label: string) {
  const find = () =>
    owner.db
      .select({ id: diningTables.id })
      .from(diningTables)
      .where(and(eq(diningTables.restaurantId, tenant.restaurantId), eq(diningTables.label, label)));
  if ((await find()).length === 0) await newTable(label);
  return (await find())[0].id;
}

describe("/dashboard/tables", () => {
  it("lists the tables an owner has added", async () => {
    await newTable("7", "4");
    await newTable("Patio 1", "6");

    const html = await screen(TablesScreen);

    expect(html).toContain('value="Patio 1"');
    expect(html).toContain('value="6"');
    expect(html.indexOf('value="7"')).toBeLessThan(html.indexOf('value="Patio 1"'));
    expect(html).toContain('href="/dashboard/tables/print"');
  });

  it("posts to the route behind it", async () => {
    expect(await screen(TablesScreen)).toContain('action="/api/tables"');
  });

  it("offers each table a regenerate form, to its own route", async () => {
    const seven = await tableIdOf("7");
    const patio = await tableIdOf("Patio 1");

    const html = await screen(TablesScreen);

    expect(html).toContain(`action="/api/tables/${seven}/regenerate"`);
    expect(html).toContain(`action="/api/tables/${patio}/regenerate"`);
    expect(html).toContain("Regenerate QR");
  });

  it("offers no print sheet until there's a table", async () => {
    const html = await screen(TablesScreen);
    expect(html).toContain("No tables yet");
    expect(html).not.toContain("/dashboard/tables/print");
  });

  it("refuses staff with forbidden(), before any data renders", async () => {
    session.tenant = { ...tenant, role: "staff" };
    expect(await statusOf(() => TablesScreen())).toBe(403);
  });
});

const tableId = async (label: string) => {
  const [{ id }] = await owner.db
    .select({ id: diningTables.id })
    .from(diningTables)
    .where(and(eq(diningTables.restaurantId, tenant.restaurantId), eq(diningTables.label, label)));
  return id;
};
const edit = async (label: string, fields: Record<string, string>) => {
  const id = await tableId(label);
  return editTable(post(`/api/tables/${id}`, fields), tableParams(id));
};

describe("/dashboard/tables, managing", () => {
  it("shows each table's position, label, seats and bookable toggle, with its actions", async () => {
    await newTable("7", "4");
    await newTable("Bar", "2");
    const id = await tableId("Bar");
    await edit("Bar", { label: "Bar", capacity: "2", bookable: "false" });

    const html = await screen(TablesScreen);

    expect(html).toContain(`action="/api/tables/${id}"`);
    expect(html).toContain(`action="/api/tables/${id}/move"`);
    expect(html).toContain(`action="/api/tables/${id}/archive"`);
    expect(html).toContain("Bookable online");
    // The second table's box is not ticked, the first's is.
    const [first, second] = html.split("<li").slice(1);
    expect(first).toContain('checked=""');
    expect(second).not.toContain('checked=""');
    expect(first).toContain(">1</span>");
    expect(second).toContain(">2</span>");
  });

  it("can't move the first table up or the last down", async () => {
    await newTable("A");
    await newTable("B");

    const [first, second] = (await screen(TablesScreen)).split("<li").slice(1);

    expect(first.match(/<button[^>]*disabled=""[^>]*>Move up/)).not.toBeNull();
    expect(first.match(/<button[^>]*disabled=""[^>]*>Move down/)).toBeNull();
    expect(second.match(/<button[^>]*disabled=""[^>]*>Move down/)).not.toBeNull();
  });

  it("edits a table, and the list shows it", async () => {
    await newTable("7", "4");

    const response = await edit("7", { label: "Window 7", capacity: "6", bookable: "false" });

    expect(response.status).toBe(303);
    const html = await screen(TablesScreen);
    expect(html).toContain('value="Window 7"');
    expect(html).toContain('value="6"');
  });

  it("refuses a taken label with a reason the form can show", async () => {
    await newTable("7");
    await newTable("8");

    const response = await edit("8", { label: "7", capacity: "4", bookable: "true" });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Another table already has that label." });
  });

  it.each([
    { label: "", capacity: "4", bookable: "true" },
    { label: "7", capacity: "101", bookable: "true" },
    { label: "7", capacity: "4", bookable: "maybe" },
  ])("refuses %j with a reason, and changes nothing", async (fields) => {
    await newTable("7");

    const response = await edit("7", fields);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expect.any(String) });
    expect(await screen(TablesScreen)).toContain('value="7"');
  });

  it("is a 404 for a malformed id, and for one that isn't a table", async () => {
    for (const id of ["not-a-uuid", crypto.randomUUID()]) {
      expect(
        await statusOf(() =>
          editTable(post(`/api/tables/${id}`, { label: "1", capacity: "1", bookable: "true" }), tableParams(id)),
        ),
      ).toBe(404);
    }
  });

  it("moves a table down, and refuses another direction", async () => {
    await newTable("A");
    await newTable("B");
    const id = await tableId("A");

    expect((await move(post(`/api/tables/${id}/move`, { direction: "down" }), tableParams(id))).status).toBe(303);
    expect((await move(post(`/api/tables/${id}/move`, { direction: "left" }), tableParams(id))).status).toBe(400);

    const html = await screen(TablesScreen);
    expect(html.indexOf('value="B"')).toBeLessThan(html.indexOf('value="A"'));
  });

  it("archives a table: off the list and the print sheet", async () => {
    await newTable("Gone");
    await newTable("Kept");
    const id = await tableId("Gone");

    const response = await archive(post(`/api/tables/${id}/archive`), tableParams(id));

    expect(response.status).toBe(303);
    const list = await screen(TablesScreen);
    const sheet = await screen(PrintSheet);
    expect(list).not.toContain('value="Gone"');
    expect(sheet).not.toContain("Gone");
    expect(sheet).toContain("Kept");
  });

  it("a second archive is a 404", async () => {
    await newTable("7");
    const id = await tableId("7");
    await archive(post(`/api/tables/${id}/archive`), tableParams(id));

    expect(await statusOf(() => archive(post(`/api/tables/${id}/archive`), tableParams(id)))).toBe(404);
  });

  it("refuses staff on all three routes", async () => {
    await newTable("7");
    const id = await tableId("7");
    session.tenant = { ...tenant, role: "staff" };

    expect(await statusOf(() => editTable(post(`/api/tables/${id}`, { label: "x", capacity: "1", bookable: "true" }), tableParams(id)))).toBe(403);
    expect(await statusOf(() => move(post(`/api/tables/${id}/move`, { direction: "down" }), tableParams(id)))).toBe(403);
    expect(await statusOf(() => archive(post(`/api/tables/${id}/archive`), tableParams(id)))).toBe(403);
    session.tenant = tenant;
    expect(await screen(TablesScreen)).toContain('value="7"');
  });
});

describe("the tables route", () => {
  it("refuses an unusable capacity with a reason, and saves nothing", async () => {
    const response = await newTable("7", "0");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expect.any(String) });
    expect(await screen(TablesScreen)).toContain("No tables yet");
  });

  it("refuses a blank label with a reason", async () => {
    expect((await newTable("  ", "4")).status).toBe(400);
  });

  it("refuses a label a live table has, with a reason the form can show", async () => {
    await newTable("7");

    const response = await newTable("7", "2");

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Another table already has that label." });
  });
});

describe("/dashboard/tables/print", () => {
  it("has a card for a table the moment it is added: restaurant, label, instruction and Wi-Fi", async () => {
    await newTable("Patio 1");

    const html = await screen(PrintSheet);

    expect(html).toContain("Mama&#x27;s Kitchen");
    expect(html).toContain("Patio 1");
    expect(html).toContain("Scan to see the menu");
    expect(html).toContain("Wi-Fi: Mamas Guest, password sadza-and-stew");
    expect(html).toContain("<svg");
  });

  it("encodes the app's address and the table's token, and nothing of the table or restaurant", async () => {
    await newTable("Patio 1");
    const [{ qrToken }] = await owner.db
      .select({ qrToken: diningTables.qrToken })
      .from(diningTables)
      .where(eq(diningTables.restaurantId, tenant.restaurantId));
    const expected = await qrSvg(tableCodeUrl(getEnv().NEXT_PUBLIC_APP_URL, qrToken));

    const html = await screen(PrintSheet);

    expect(html).toContain(expected.trim());
    expect(html).not.toContain(tenant.restaurantId);
  });

  it("is at least 3cm wide, and one card each for the tables", async () => {
    await newTable("1");
    await newTable("2");
    await newTable("3");

    const html = await screen(PrintSheet);

    expect(html.match(/w-\[5cm\]/g)).toHaveLength(3);
  });

  it("is a page of its own sheet: A4, and the cards don't split", async () => {
    await newTable("1");
    const html = await screen(PrintSheet);
    expect(html).toContain("size:A4");
    expect(html).toContain("break-inside-avoid");
  });

  it("fits three rows of cards in the A4 page: 3 x card height is within 297mm less margins", async () => {
    await newTable("1");
    const html = await screen(PrintSheet);
    const margin = Number(/@page\{size:A4;margin:(\d+)mm\}/.exec(html)?.[1]);
    const card = Number(/print:h-\[(\d+)mm\]/.exec(html)?.[1]);
    expect(margin).toBeGreaterThan(0);
    expect(card * 3).toBeLessThanOrEqual(297 - 2 * margin);
    expect(html).toContain("print:gap-0");
  });

  describe("options", () => {
    const render = (query: Record<string, string | string[]>) =>
      screen(() => PrintSheet({ searchParams: Promise.resolve(query) }));
    const cardsIn = (html: string) => html.match(/<li class="flex flex-col/g)?.length ?? 0;
    const idOf = async (label: string) =>
      (
        await owner.db
          .select({ id: diningTables.id })
          .from(diningTables)
          .where(and(eq(diningTables.restaurantId, tenant.restaurantId), eq(diningTables.label, label)))
      )[0].id;

    it("prints every table by default, with no menu card", async () => {
      await newTable("A");
      await newTable("B");
      const html = await render({});
      expect(cardsIn(html)).toBe(2);
      expect(html).not.toContain("View our menu</p>");
    });

    it("prints only the selected tables", async () => {
      await newTable("Alpha");
      await newTable("Bravo");
      await newTable("Charlie");
      const html = await render({ scope: "selected", table: [await idOf("Bravo")] });
      expect(cardsIn(html)).toBe(1);
      expect(html).toContain(">Bravo</p>");
      expect(html).not.toContain(">Alpha</p>");
      expect(html).not.toContain(">Charlie</p>");
    });

    it("selected with nothing ticked prints no card and says so", async () => {
      await newTable("Alpha");
      const html = await render({ scope: "selected" });
      expect(cardsIn(html)).toBe(0);
      expect(html).toContain("Tick at least one table");
    });

    it("never renders a card for another restaurant's table id", async () => {
      await newTable("Mine");
      const otherId = crypto.randomUUID();
      await owner.db.insert(restaurants).values({
        id: otherId,
        name: "Other place",
        slug: `screens-${otherId}`,
        menuToken: otherId,
        currencyMode: "usd_only",
      });
      const [{ id: theirTable }] = await owner.db
        .insert(diningTables)
        .values({ restaurantId: otherId, label: "Theirs", capacity: 2, qrToken: "U".repeat(22) })
        .returning({ id: diningTables.id });
      try {
        const html = await render({
          scope: "selected",
          table: [theirTable, await idOf("Mine")],
        });
        expect(cardsIn(html)).toBe(1);
        expect(html).not.toContain("Theirs");
        expect(html).not.toContain(await qrSvg(tableCodeUrl(getEnv().NEXT_PUBLIC_APP_URL, "U".repeat(22))));

        const onlyTheirs = await render({ scope: "selected", table: [theirTable] });
        expect(cardsIn(onlyTheirs)).toBe(0);
        expect(onlyTheirs).not.toContain("Theirs");
      } finally {
        await owner.db.delete(diningTables).where(eq(diningTables.restaurantId, otherId));
        await owner.db.delete(restaurants).where(eq(restaurants.id, otherId));
      }
    });

    it("ignores ids that aren't ids", async () => {
      await newTable("Alpha");
      const html = await render({ scope: "selected", table: ["x' or 1=1", "../../etc"] });
      expect(cardsIn(html)).toBe(0);
    });

    it("adds the generic menu card, which encodes /m/{menu_token}, ahead of the tables", async () => {
      await newTable("Alpha");
      const html = await render({ menu: "1" });
      expect(cardsIn(html)).toBe(2);
      expect(html).toContain("View our menu");
      const menuCode = await qrSvg(menuCodeUrl(getEnv().NEXT_PUBLIC_APP_URL, tenant.restaurantId));
      expect(html).toContain(menuCode.trim());
      expect(html.indexOf("View our menu")).toBeLessThan(html.indexOf(">Alpha</p>"));
    });

    it("can print the menu card alone", async () => {
      await newTable("Alpha");
      const html = await render({ scope: "selected", menu: "1" });
      expect(cardsIn(html)).toBe(1);
      expect(html).toContain("View our menu");
    });

    it("leaves the Wi-Fi password off when asked, and keeps the network name", async () => {
      await newTable("Alpha");
      const html = await render({ nopassword: "1" });
      expect(html).toContain("Wi-Fi: Mamas Guest<");
      expect(html).not.toContain("sadza-and-stew</p>");
      expect(html).not.toContain("password sadza-and-stew");
    });

    it("shows no Wi-Fi line when none is set", async () => {
      await owner.db
        .update(restaurants)
        .set({ wifiName: null, wifiPassword: null })
        .where(eq(restaurants.id, tenant.restaurantId));
      await newTable("Alpha");
      expect(await render({})).not.toContain("Wi-Fi:");
    });

    it("the form keeps its ticks: selected, the table and the menu card", async () => {
      await newTable("Alpha");
      const html = await render({ scope: "selected", table: [await idOf("Alpha")], menu: "1" });
      expect(html).toMatch(/<input[^>]*name="menu"[^>]*checked/);
      expect(html).toMatch(/<input[^>]*name="scope"[^>]*checked=""[^>]*value="selected"/);
    });

    it("refuses staff with forbidden() whatever the options", async () => {
      await newTable("Alpha");
      session.tenant = { ...tenant, role: "staff" };
      expect(await statusOf(() => render({ scope: "selected", menu: "1" }))).toBe(403);
    });
  });

  it("gives long names and labels a box that can't grow past the card", async () => {
    await newTable("A very long label for one table, going on and on!!");
    const html = await screen(PrintSheet);
    expect(html).toMatch(/line-clamp-2[^"]*print:h-\[\d+(\.\d+)?mm\]/);
    expect(html).toContain("text-lg");
    expect(html).not.toContain("text-5xl");
  });

  it("holds only this restaurant's tables", async () => {
    await newTable("Mine");
    const otherId = crypto.randomUUID();
    await owner.db.insert(restaurants).values({
      id: otherId,
      name: "Other place",
      slug: `screens-${otherId}`,
      menuToken: otherId,
      currencyMode: "usd_only",
    });
    await owner.db.insert(diningTables).values({
      restaurantId: otherId,
      label: "Theirs",
      capacity: 2,
      qrToken: "T".repeat(22),
    });
    try {
      const html = await screen(PrintSheet);

      expect(html).toContain("Mine");
      expect(html).not.toContain("Theirs");
      // The URL is only in the QR's path data, so look for the whole picture.
      const theirCode = await qrSvg(tableCodeUrl(getEnv().NEXT_PUBLIC_APP_URL, "T".repeat(22)));
      expect(html).not.toContain(theirCode.trim());
    } finally {
      await owner.db.delete(diningTables).where(eq(diningTables.restaurantId, otherId));
      await owner.db.delete(restaurants).where(eq(restaurants.id, otherId));
    }
  });

  it("says to add a table first when there are none", async () => {
    expect(await screen(PrintSheet)).toContain("Add a table first");
  });

  it("refuses staff with forbidden(), before any code renders", async () => {
    await newTable("1");
    session.tenant = { ...tenant, role: "staff" };
    expect(await statusOf(() => PrintSheet())).toBe(403);
  });

  it("tells the owner on the settings screen that customers see the Wi-Fi password", async () => {
    const html = await screen(SettingsScreen);
    expect(html).toContain("customers will see it");
    expect(html).toContain("guest network");
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

describe("regenerating a table's code", () => {
  const tokenOfTable = async (id: string) =>
    (await owner.db.select({ t: diningTables.qrToken }).from(diningTables).where(eq(diningTables.id, id)))[0].t;

  it("changes what the print sheet encodes, so the sheet to reprint has the new code", async () => {
    const id = await tableIdOf("7");
    const old = await tokenOfTable(id);

    expect((await regenerateTable(post(`/api/tables/${id}/regenerate`), tableParams(id))).status).toBe(303);

    const fresh = await tokenOfTable(id);
    const html = await screen(PrintSheet);
    const url = (token: string) => qrSvg(tableCodeUrl(getEnv().NEXT_PUBLIC_APP_URL, token));
    expect(html).toContain((await url(fresh)).trim());
    expect(html).not.toContain((await url(old)).trim());
  });

  it.each(["not-a-uuid", crypto.randomUUID()])("is a 404 for a table that isn't there: %s", async (id) => {
    expect(await statusOf(() => regenerateTable(post(`/api/tables/${id}/regenerate`), tableParams(id)))).toBe(404);
  });
});
