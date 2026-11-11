import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import sharp from "sharp";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as addCategory } from "@/app/api/menu/categories/route";
import { POST as archiveCategory } from "@/app/api/menu/categories/[categoryId]/archive/route";
import { POST as renameCategory } from "@/app/api/menu/categories/[categoryId]/route";
import { POST as reorderCategories } from "@/app/api/menu/categories/order/route";
import { POST as archiveItem } from "@/app/api/menu/items/[itemId]/archive/route";
import { POST as editItem } from "@/app/api/menu/items/[itemId]/route";
import { POST as setRate } from "@/app/api/menu/exchange-rate/route";
import { POST as addItem } from "@/app/api/menu/items/route";
import { POST as removePhoto } from "@/app/api/menu/items/[itemId]/photo/remove/route";
import { POST as setPhoto } from "@/app/api/menu/items/[itemId]/photo/route";
import { POST as switchSpecial } from "@/app/api/menu/specials/[specialId]/active/route";
import { POST as addSpecial } from "@/app/api/menu/specials/route";
import { POST as addBundle } from "@/app/api/menu/bundles/route";
import { POST as saveSettings } from "@/app/api/restaurant/route";
import { POST as deactivate } from "@/app/api/staff/[staffId]/deactivate/route";
import { POST as changeRole } from "@/app/api/staff/[staffId]/role/route";
import { POST as addStaff } from "@/app/api/staff/route";
import { POST as archive } from "@/app/api/tables/[tableId]/archive/route";
import { POST as move } from "@/app/api/tables/[tableId]/move/route";
import { POST as regenerateTable } from "@/app/api/tables/[tableId]/regenerate/route";
import { POST as editTable } from "@/app/api/tables/[tableId]/route";
import { POST as addTable } from "@/app/api/tables/route";
import {
  auditLog,
  bookings,
  bookingSettings,
  categories,
  diningTables,
  exchangeRates,
  menuItems,
  restaurants,
  servicePeriods,
  specials,
  staff,
} from "@/db/schema";
import { getEnv } from "@/lib/env";
import { FORM_FETCH_HEADER } from "@/lib/form-response";
import { menuCodeUrl, qrSvg, tableCodeUrl } from "@/lib/qr-code";
import type { TenantContext } from "@/lib/tenant";
import {
  openOwnerDatabase,
  testDatabaseSettings,
} from "../../../test/integration/database";
import { aBooking } from "../../../test/integration/bookings";
import { statusOf } from "../../../test/integration/http";
import { Dashboard } from "./dashboard";
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

// Photos go through the storage interface, faked so nothing reaches R2.
vi.mock("@/lib/storage", () => ({
  uploadImage: async (key: string) => ({ key, url: `https://cdn.example.test/${key}` }),
  deleteImage: async () => {},
  getUrl: (key: string) => `https://cdn.example.test/${key}`,
}));

// A client form's props never reach static markup, so what it would say once
// clicked is surfaced here beside the real form.
vi.mock("./action-form", async (original) => {
  const { ActionForm } = await original<typeof import("./action-form")>();
  return {
    ActionForm: (props: React.ComponentProps<typeof ActionForm>) => (
      <div data-confirmation={props.confirmation} data-saved-message={props.savedMessage}>
        <ActionForm {...props} />
      </div>
    ),
  };
});

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

/** An item made through the route, and its id. */
const newItem = async () => {
  await addItem(post("/api/menu/items", item(await newCategory())));
  const [{ id }] = await owner.db
    .select({ id: menuItems.id })
    .from(menuItems)
    .where(eq(menuItems.restaurantId, tenant.restaurantId));
  return id;
};

const specialIdOf = async (menuItemId: string) =>
  (
    await owner.db
      .select({ id: specials.id })
      .from(specials)
      .where(eq(specials.menuItemId, menuItemId))
  )[0].id;

const itemParams = (itemId: string) => ({ params: Promise.resolve({ itemId }) });

const photoPost = async (path: string, headers: Record<string, string> = {}) => {
  const jpeg = await sharp({
    create: { width: 64, height: 48, channels: 3, background: "#c33" },
  })
    .jpeg()
    .toBuffer();
  const body = new FormData();
  body.set("photo", new File([new Uint8Array(jpeg)], "dish.jpg", { type: "image/jpeg" }));
  return new NextRequest(new URL(path, "http://localhost:3000"), {
    method: "POST",
    body,
    headers,
  });
};

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
      "POST /api/menu/exchange-rate",
      "/dashboard/menu",
      (headers) =>
        setRate(post("/api/menu/exchange-rate", { usdToZig: "26.2" }, headers)),
    ],
    [
      "POST /api/menu/items/[itemId]/photo",
      "/dashboard/menu",
      async (headers) => {
        const id = await newItem();
        return setPhoto(await photoPost(`/api/menu/items/${id}/photo`, headers), itemParams(id));
      },
    ],
    [
      "POST /api/menu/items/[itemId]/photo/remove",
      "/dashboard/menu",
      async (headers) => {
        const id = await newItem();
        return removePhoto(
          post(`/api/menu/items/${id}/photo/remove`, {}, headers),
          itemParams(id),
        );
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

  it("asks for a category first, since an item needs one: the empty state is that form", async () => {
    const html = await screen(MenuScreen);
    expect(html).toContain("Start your menu with a category");
    expect(html).toContain('action="/api/menu/categories"');
    expect(html).toContain('id="first-category"');
    expect(html).toContain("Dishes, specials and bundles can be added once you have a category.");
    expect(html).not.toContain('action="/api/menu/items"');
    expect(html).not.toContain('action="/api/menu/bundles"');
    expect(html).not.toContain('href="#add-item"');
  });

  it("offers quick picks that only fill the field, never a form of their own", async () => {
    const html = await screen(MenuScreen);
    const picks = html.slice(html.indexOf('aria-label="Quick picks"'));
    for (const name of ["Starters", "Mains", "Sides", "Drinks", "Desserts"]) {
      expect(picks).toContain(`type="button"`);
      expect(picks).toContain(`>${name}</button>`);
    }
    // One category form: the side column's comes back once there is a category.
    expect(html.split('action="/api/menu/categories"')).toHaveLength(2);
  });

  it("drops the empty state once there is a category, for the usual forms", async () => {
    await newCategory("Mains");
    const html = await screen(MenuScreen);
    expect(html).not.toContain("Start your menu with a category");
    expect(html).not.toContain('aria-label="Quick picks"');
    expect(html).toContain("Add a category");
    expect(html).toContain('action="/api/menu/items"');
  });

  it("shows staff a plain empty menu, with no form", async () => {
    session.tenant = { ...tenant, role: "staff" };
    const html = await screen(MenuScreen);
    expect(html).toContain("The owner hasn&#x27;t added anything to the menu.");
    expect(html).not.toContain("Start your menu with a category");
    expect(html).not.toContain('action="/api/menu/categories"');
  });

  it("offers a photo picker for an item with none, and no remove button", async () => {
    const id = await newItem();

    const html = await screen(MenuScreen);

    expect(html).toContain('aria-label="Add photo for Beef stew"');
    expect(html).toContain('accept="image/*"');
    expect(html).not.toContain("Remove photo");
    expect(html).not.toContain("<img");
    expect(id).toBeTruthy();
  });

  it("shows an item's 320px thumbnail, from the storage interface, once it has a photo", async () => {
    const id = await newItem();
    await setPhoto(await photoPost(`/api/menu/items/${id}/photo`), itemParams(id));
    const [{ photoKey }] = await owner.db
      .select({ photoKey: menuItems.photoKey })
      .from(menuItems)
      .where(eq(menuItems.id, id));

    const html = await screen(MenuScreen);

    expect(html).toContain(`src="https://cdn.example.test/${photoKey}-320.webp"`);
    expect(html).toContain('width="64"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('aria-label="Change photo for Beef stew"');
    expect(html).toContain("Remove photo");
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

  it("gives staff the toggle and nothing else that changes the menu", async () => {
    const itemId = await newItem();
    await setPhoto(await photoPost(`/api/menu/items/${itemId}/photo`), itemParams(itemId));
    await newCategory("Sides");
    await setRate(post("/api/menu/exchange-rate", { usdToZig: "26.2" }));
    await addSpecial(post("/api/menu/specials", { menuItemId: itemId, title: "Taco Tuesday", priceUsd: "6" }));
    const specialId = await specialIdOf(itemId);
    const asOwner = await screen(MenuScreen);
    session.tenant = { ...tenant, role: "staff" };

    const html = await screen(MenuScreen);

    expect(html).toContain("Mains");
    expect(html).toContain("Sides");
    const owners = [
      "/api/menu/exchange-rate",
      'name="usdToZig"',
      "Exchange rate",
      'name="priceUsd"',
      'name="priceZig"',
      "Calculated:",
      'name="sortOrder"',
      "Edit",
      `action="/api/menu/items/${itemId}"`,
      `/api/menu/items/${itemId}/archive`,
      "Archive item",
      "Archive category",
      'name="moveItemsTo"',
      "Rename",
      "Category name",
      "Move Mains",
      "Drag to reorder",
      `/api/menu/items/${itemId}/photo`,
      'type="file"',
      "Remove photo",
      "Change photo",
      // Specials (S-26): the list, its switch, and the form that adds one.
      "Specials",
      "Taco Tuesday",
      "On now",
      "Turn off",
      `/api/menu/specials/${specialId}/active`,
      'action="/api/menu/specials"',
      "Add a special",
      'name="menuItemId"',
      'name="startDate"',
      'name="endDate"',
      'name="title"',
      'name="active"',
    ];
    for (const control of owners) {
      // So a control that's renamed fails here, rather than this passing on nothing.
      expect(asOwner).toContain(control);
      expect(html).not.toContain(control);
    }
    expect(html).not.toMatch(/action="\/api\/menu\/categories\//);
  });
});

describe("/dashboard/menu bundles", () => {
  it("lists a bundle out of its window for the owner, who adds one here; staff get its sold-out toggle alone", async () => {
    const categoryId = await newCategory("Combos");
    const added = await addBundle(
      post("/api/menu/bundles", {
        name: "Burger combo",
        description: "Burger, chips and a drink",
        priceUsd: "9.50",
        categoryId,
        startDate: "2031-03-01",
      }),
    );
    expect(added.status).toBeLessThan(400);
    const asOwner = await screen(MenuScreen);
    session.tenant = { ...tenant, role: "staff" };

    const asStaff = await screen(MenuScreen);

    // Out of its window, and still here for both: it can be managed and sold out.
    for (const html of [asOwner, asStaff]) {
      expect(html).toContain("Burger combo");
      expect(html).toContain("Burger, chips and a drink");
      expect(html).toContain("Bundle");
      expect(html).toContain("Not on the menu now");
      expect(html).toContain("Mark sold out");
      expect(html).toMatch(/action="\/api\/menu\/items\/[0-9a-f-]+\/availability"/);
    }
    // The control that adds one, and the bundle's own listing in Specials (S-26).
    for (const control of ['action="/api/menu/bundles"', "Add a bundle", "(bundle)", "Starts later"]) {
      expect(asOwner).toContain(control);
      expect(asStaff).not.toContain(control);
    }
  });

  it("answers a bad bundle form with its reason, and adds nothing", async () => {
    const categoryId = await newCategory("Combos");
    const response = await addBundle(
      post("/api/menu/bundles", { name: "Combo", description: "", priceUsd: "9", categoryId }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "List what's included, in up to 1000 characters." });
    expect(await owner.db.select().from(menuItems).where(eq(menuItems.restaurantId, tenant.restaurantId))).toEqual([]);
  });

  it("refuses a blank start with an end date already gone, with a reason, and adds nothing", async () => {
    const categoryId = await newCategory("Combos");

    const response = await addBundle(
      post("/api/menu/bundles", {
        name: "Combo",
        description: "Burger and chips",
        priceUsd: "9",
        categoryId,
        endDate: "2020-01-07",
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "That end date has passed. Choose today or later.",
    });
    expect(await owner.db.select().from(menuItems).where(eq(menuItems.restaurantId, tenant.restaurantId))).toEqual([]);
  });

  it("refuses an edit that blanks a bundle's description, and keeps it; a regular item's may be blank", async () => {
    const categoryId = await newCategory("Combos");
    await addBundle(
      post("/api/menu/bundles", {
        name: "Burger combo",
        description: "Burger, chips and a drink",
        priceUsd: "9.50",
        categoryId,
      }),
    );
    await addItem(post("/api/menu/items", { ...item(categoryId), name: "Plain" }));
    const idByName = async (name: string) =>
      (
        await owner.db
          .select({ id: menuItems.id })
          .from(menuItems)
          .where(and(eq(menuItems.restaurantId, tenant.restaurantId), eq(menuItems.name, name)))
      )[0].id;
    const bundleId = await idByName("Burger combo");
    const plainId = await idByName("Plain");
    const edit = (itemId: string, fields: Record<string, string>) =>
      editItem(
        post(`/api/menu/items/${itemId}`, { ...item(categoryId), sortOrder: "0", ...fields }),
        itemParams(itemId),
      );

    const refused = await edit(bundleId, { name: "Burger combo", description: "  " });

    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "List what's included, in up to 1000 characters." });
    const [row] = await owner.db.select().from(menuItems).where(eq(menuItems.id, bundleId));
    expect(row.description).toBe("Burger, chips and a drink");
    expect((await edit(plainId, { name: "Plain", description: "" })).status).toBe(303);
  });
});

describe("/dashboard/menu editing", () => {
  const idOf = async (name: string) => {
    const [{ id }] = await owner.db
      .select({ id: menuItems.id })
      .from(menuItems)
      .where(and(eq(menuItems.restaurantId, tenant.restaurantId), eq(menuItems.name, name)));
    return id;
  };

  it("posts each category's rename and archive, and each item's edit and archive", async () => {
    const categoryId = await newCategory("Mains");
    await newCategory("Sides");
    await addItem(post("/api/menu/items", item(categoryId)));
    const itemId = await idOf("Beef stew");

    const html = await screen(MenuScreen);

    expect(html).toContain(`action="/api/menu/categories/${categoryId}"`);
    expect(html).toContain(`action="/api/menu/categories/${categoryId}/archive"`);
    expect(html).toContain(`action="/api/menu/items/${itemId}"`);
    expect(html).toContain(`action="/api/menu/items/${itemId}/archive"`);
  });

  it("fills the edit form's prices, with the same calculated hint as the add form", async () => {
    const categoryId = await newCategory("Mains");
    await setRate(post("/api/menu/exchange-rate", { usdToZig: "26.2" }));
    await addItem(post("/api/menu/items", { ...item(categoryId), priceZig: "300" }));
    const itemId = await idOf("Beef stew");

    const html = await screen(MenuScreen);

    const edit = html.split("<form").find((form) =>
      form.includes(`action="/api/menu/items/${itemId}"`),
    )!;
    expect(edit).toMatch(/<input[^>]*name="priceUsd"[^>]*value="8.50"/);
    expect(edit).toMatch(/<input[^>]*name="priceZig"[^>]*value="300"/);
    expect(edit).toContain("Calculated: ZiG 230 at rate 26.2");
  });

  it("edits the ZiG price through the route, and refuses what the add form refuses", async () => {
    const categoryId = await newCategory("Mains");
    await addItem(post("/api/menu/items", item(categoryId)));
    const itemId = await idOf("Beef stew");
    const edit = (fields: Record<string, string>) =>
      editItem(post(`/api/menu/items/${itemId}`, { ...item(categoryId), sortOrder: "0", ...fields }), {
        params: Promise.resolve({ itemId }),
      });
    const prices = async () => {
      const [row] = await owner.db
        .select({ priceUsd: menuItems.priceUsd, priceZig: menuItems.priceZig })
        .from(menuItems)
        .where(eq(menuItems.id, itemId));
      return row;
    };

    expect((await edit({ priceUsd: "", priceZig: "210" })).status).toBe(303);
    expect(await prices()).toEqual({ priceUsd: null, priceZig: "210" });

    const refused: Record<string, string>[] = [
      { priceZig: "1e3" },
      { priceUsd: "", priceZig: "" },
    ];
    for (const fields of refused) {
      const response = await edit(fields);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: expect.any(String) });
    }
    expect(await prices()).toEqual({ priceUsd: null, priceZig: "210" });
  });

  it("keeps the photo form on the item's edit form, and the photo through an edit", async () => {
    const itemId = await newItem();
    await setPhoto(await photoPost(`/api/menu/items/${itemId}/photo`), itemParams(itemId));
    const photo = async () =>
      (await owner.db.select().from(menuItems).where(eq(menuItems.id, itemId)))[0].photoKey;
    const before = await photo();
    const [{ categoryId }] = await owner.db
      .select({ categoryId: menuItems.categoryId })
      .from(menuItems)
      .where(eq(menuItems.id, itemId));

    await editItem(
      post(`/api/menu/items/${itemId}`, { ...item(categoryId), name: "Goat stew", sortOrder: "0" }),
      itemParams(itemId),
    );

    expect(before).not.toBeNull();
    expect(await photo()).toBe(before);
    const html = await screen(MenuScreen);
    const editor = html.slice(html.indexOf("<details"), html.indexOf("</details>"));
    expect(editor).toContain('aria-label="Change photo for Goat stew"');
    expect(editor).toContain(`action="/api/menu/items/${itemId}"`);
  });

  it("answers a photo change on an archived item with a 404, and keeps the photo", async () => {
    const itemId = await newItem();
    await setPhoto(await photoPost(`/api/menu/items/${itemId}/photo`), itemParams(itemId));
    const [{ photoKey }] = await owner.db
      .select({ photoKey: menuItems.photoKey })
      .from(menuItems)
      .where(eq(menuItems.id, itemId));
    await archiveItem(post(`/api/menu/items/${itemId}/archive`), itemParams(itemId));

    expect(
      await statusOf(async () =>
        setPhoto(await photoPost(`/api/menu/items/${itemId}/photo`), itemParams(itemId)),
      ),
    ).toBe(404);
    expect(
      await statusOf(() =>
        removePhoto(post(`/api/menu/items/${itemId}/photo/remove`), itemParams(itemId)),
      ),
    ).toBe(404);

    const [row] = await owner.db
      .select({ photoKey: menuItems.photoKey })
      .from(menuItems)
      .where(eq(menuItems.id, itemId));
    expect(row.photoKey).toBe(photoKey);
  });

  it("asks where a category's items should go, only when it has some", async () => {
    const full = await newCategory("Full");
    await newCategory("Empty");
    await addItem(post("/api/menu/items", item(full)));

    const html = await screen(MenuScreen);

    const forms = html.split("<form").filter((form) => form.includes("/archive"));
    const withTarget = forms.filter((form) => form.includes('name="moveItemsTo"'));
    expect(withTarget).toHaveLength(1);
    expect(withTarget[0]).toContain(`action="/api/menu/categories/${full}/archive"`);
  });

  it("says to add another category first when the only one has items", async () => {
    const categoryId = await newCategory("Mains");
    await addItem(post("/api/menu/items", item(categoryId)));

    const html = await screen(MenuScreen);

    expect(html).toContain("Add another category before archiving");
    expect(html).not.toContain(`/api/menu/categories/${categoryId}/archive`);
  });

  it("renames, edits and archives through the routes, and the editor follows", async () => {
    const categoryId = await newCategory("Mains");
    await addItem(post("/api/menu/items", item(categoryId)));
    const itemId = await idOf("Beef stew");

    await renameCategory(post(`/api/menu/categories/${categoryId}`, { name: "Big plates" }), {
      params: Promise.resolve({ categoryId }),
    });
    await editItem(
      post(`/api/menu/items/${itemId}`, {
        ...item(categoryId),
        name: "Goat stew",
        priceUsd: "9.00",
        sortOrder: "2",
      }),
      { params: Promise.resolve({ itemId }) },
    );
    let html = await screen(MenuScreen);
    expect(html).toContain("Big plates");
    expect(html).toContain("Goat stew");
    expect(html).not.toContain(">Beef stew<");

    await archiveItem(post(`/api/menu/items/${itemId}/archive`), {
      params: Promise.resolve({ itemId }),
    });
    await archiveCategory(post(`/api/menu/categories/${categoryId}/archive`), {
      params: Promise.resolve({ categoryId }),
    });
    html = await screen(MenuScreen);
    expect(html).not.toContain("Goat stew");
    expect(html).not.toContain("Big plates");
  });

  it("answers a category with items and nowhere to put them with a 409 that says why", async () => {
    const categoryId = await newCategory("Mains");
    await addItem(post("/api/menu/items", item(categoryId)));

    const response = await archiveCategory(post(`/api/menu/categories/${categoryId}/archive`), {
      params: Promise.resolve({ categoryId }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: expect.stringContaining("Choose where") });
  });

  it("moves the items when told where", async () => {
    const from = await newCategory("Old");
    const to = await newCategory("New");
    await addItem(post("/api/menu/items", item(from)));

    const response = await archiveCategory(
      post(`/api/menu/categories/${from}/archive`, { moveItemsTo: to }, { [FORM_FETCH_HEADER]: "1" }),
      { params: Promise.resolve({ categoryId: from }) },
    );

    expect(response.status).toBe(204);
    expect(await screen(MenuScreen)).toContain("Beef stew");
  });

  it("refuses a bad edit with a reason, and an item left with no price", async () => {
    const categoryId = await newCategory("Mains");
    await addItem(post("/api/menu/items", item(categoryId)));
    const itemId = await idOf("Beef stew");
    const edit = (fields: Record<string, string>) =>
      editItem(post(`/api/menu/items/${itemId}`, { ...item(categoryId), sortOrder: "0", ...fields }), {
        params: Promise.resolve({ itemId }),
      });

    for (const fields of [{ priceUsd: "free" } as Record<string, string>, { name: " " }, { sortOrder: "-1" }, { priceUsd: "" }]) {
      const response = await edit(fields);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: expect.any(String) });
    }
  });

  it("saves the order a drag leaves, and refuses a malformed one", async () => {
    const [a, b] = [await newCategory("Alpha"), await newCategory("Beta")];
    const order = (ids: string[]) => {
      const body = new FormData();
      for (const id of ids) body.append("ids", id);
      return new NextRequest(new URL("/api/menu/categories/order", "http://localhost:3000"), {
        method: "POST",
        body,
      });
    };

    expect((await reorderCategories(order([b, a]))).status).toBe(303);
    const html = await screen(MenuScreen);
    expect(html.indexOf("Beta")).toBeLessThan(html.indexOf("Alpha"));

    expect((await reorderCategories(order([]))).status).toBe(400);
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

  it("asks before regenerating a code, and prompts to reprint once it's done", async () => {
    await newTable("7");
    const seven = await tableIdOf("7");

    const html = await screen(TablesScreen);

    const regenerateForm = new RegExp(
      `data-confirmation="([^"]*)" data-saved-message="([^"]*)"><form[^>]*action="/api/tables/${seven}/regenerate"`,
    );
    const [, confirmation, savedMessage] = regenerateForm.exec(html) ?? [];
    expect(confirmation).toContain("The printed code on Table 7 will stop working");
    expect(savedMessage).toBe(
      "New code made for Table 7. The old one has stopped working: reprint it from the print sheet.",
    );
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
    expect(html).toContain("Add your first table");
    expect(html).not.toContain("/dashboard/tables/print");
  });

  it("makes the add form the empty state, with the first label suggested", async () => {
    const html = await screen(TablesScreen);
    const form = html.slice(html.indexOf('id="add-table"'));
    expect(form).toContain('action="/api/tables"');
    expect(form).toContain('name="label" value="T1"');
    expect(form).toContain('name="capacity" value="2"');
    expect(form).toContain('aria-label="More seats"');
    // One add form, and no header link to it: it is already the first thing on the page.
    expect(html.split('action="/api/tables"')).toHaveLength(2);
    expect(html).not.toContain('href="#add-table"');
  });

  it("goes back to the list and the usual add form once there is a table", async () => {
    await newTable("7", "4");
    const html = await screen(TablesScreen);
    expect(html).not.toContain("Add your first table");
    expect(html).toContain("Add a table");
    expect(html).toContain('href="#add-table"');
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

    // The move buttons are icon buttons named "Move table A up" and so on (S-41).
    const disabled = (direction: string) =>
      new RegExp(`<button(?=[^>]*disabled="")[^>]*aria-label="Move table [^"]+ ${direction}"`);
    expect(first.match(disabled("up"))).not.toBeNull();
    expect(first.match(disabled("down"))).toBeNull();
    expect(second.match(disabled("down"))).not.toBeNull();
    expect(second.match(disabled("up"))).toBeNull();
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

  describe("a table with future bookings", () => {
    const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

    const book = async (
      id: string,
      from: number,
      to: number,
      fields: Partial<typeof bookings.$inferInsert> = {},
    ) => {
      const row = {
        ...aBooking(tenant.restaurantId, id, inHours(from), inHours(to)),
        guestPhone: "+263771234567",
        ...fields,
      };
      await owner.db.insert(bookings).values(row);
      return row;
    };

    it("answers 409 with the bookings, soonest first, and leaves the table", async () => {
      await newTable("7");
      const id = await tableId("7");
      await book(id, 50, 52, { guestName: "Later Guest", partySize: 1 });
      await book(id, 24, 26, { guestName: "Tendai Moyo", partySize: 4 });

      const response = await archive(post(`/api/tables/${id}/archive`), tableParams(id));

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error).toContain("Move or cancel");
      expect(body.bookings.map((b: { guestName: string }) => b.guestName)).toEqual([
        "Tendai Moyo",
        "Later Guest",
      ]);
      expect(body.bookings[0].summary).toMatch(/^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}, \d{2}:\d{2} · Tendai Moyo · 4 guests$/);
      expect(body.bookings[1].summary).toContain("1 guest");
      expect(await screen(TablesScreen)).toContain('value="7"');
    });

    it("shows no phone, and no manage token, in the refusal", async () => {
      await newTable("7");
      const id = await tableId("7");
      const row = await book(id, 24, 26);

      const text = await (await archive(post(`/api/tables/${id}/archive`), tableParams(id))).text();

      expect(text).not.toContain("263771234567");
      expect(text).not.toContain(row.manageToken);
    });

    it("tells the time on the restaurant's clock, not the server's", async () => {
      await owner.db.update(restaurants).set({ timezone: "Pacific/Kiritimati" }).where(eq(restaurants.id, tenant.restaurantId));
      await newTable("7");
      const id = await tableId("7");
      // 12:00 UTC is 02:00 the next day at +14:00.
      const noon = new Date(Date.now() + 48 * 3_600_000);
      noon.setUTCHours(12, 0, 0, 0);
      await book(id, 24, 26, { startsAt: noon, endsAt: new Date(noon.getTime() + 5_400_000), holdEndsAt: new Date(noon.getTime() + 5_400_000) });

      const body = await (await archive(post(`/api/tables/${id}/archive`), tableParams(id))).json();

      expect(body.bookings[0].summary).toContain(", 02:00 · ");
    });

    it("counts a seated booking, so a table in use can't be archived", async () => {
      await newTable("7");
      const id = await tableId("7");
      await book(id, -1, 1, { status: "seated", guestName: "Walk-in" });

      const response = await archive(post(`/api/tables/${id}/archive`), tableParams(id));

      expect(response.status).toBe(409);
      expect((await response.json()).bookings[0].summary).toContain("(seated now)");
    });

    it("lists only the bookings that block: cancelled, finished and past ones don't", async () => {
      await newTable("7");
      await newTable("8");
      const id = await tableId("7");
      await book(id, 24, 26, { status: "cancelled" });
      await book(id, 30, 32, { status: "no_show" });
      await book(id, 40, 42, { status: "completed" });
      await book(id, -9, -7);

      expect((await archive(post(`/api/tables/${id}/archive`), tableParams(id))).status).toBe(303);
    });

    it("goes through once the bookings are cancelled", async () => {
      await newTable("7");
      const id = await tableId("7");
      const row = await book(id, 24, 26);
      expect((await archive(post(`/api/tables/${id}/archive`), tableParams(id))).status).toBe(409);

      await owner.db.update(bookings).set({ status: "cancelled" }).where(eq(bookings.manageToken, row.manageToken));

      expect((await archive(post(`/api/tables/${id}/archive`, {}, { [FORM_FETCH_HEADER]: "1" }), tableParams(id))).status).toBe(204);
    });

    it("refuses staff with a 403 and no list", async () => {
      await newTable("7");
      const id = await tableId("7");
      await book(id, 24, 26);
      session.tenant = { ...tenant, role: "staff" };

      expect(await statusOf(() => archive(post(`/api/tables/${id}/archive`), tableParams(id)))).toBe(403);
    });
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
    expect(await screen(TablesScreen)).toContain("Add your first table");
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

/** The first printed card, split into its own classes and what's inside it. */
const cardIn = (html: string) => {
  const cards = html.slice(html.indexOf('<ul class="grid'));
  const [, className, content] = /<li class="([^"]*)">([\s\S]*?)<\/li>/.exec(cards) ?? [];
  return { className, content };
};

/** A print-only size on a card, in mm: a decimal must read as itself, not fall through. */
const printMm = (className: string, utility: "h" | "p" | "gap") =>
  Number(new RegExp(`(?:^| )print:${utility}-\\[(\\d+(?:\\.\\d+)?)mm\\]`).exec(className)?.[1]);

describe("what the owner is told about booking switching itself off", () => {
  async function turnBookingOn() {
    await owner.db
      .update(restaurants)
      .set({ contactPhone: "+263771234567" })
      .where(eq(restaurants.id, tenant.restaurantId));
    await owner.db.insert(servicePeriods).values({
      restaurantId: tenant.restaurantId,
      name: "Lunch",
      weekday: 1,
      opensAt: "12:00",
      lastBookingAt: "14:00",
      closesAt: "15:00",
    });
    await owner.db
      .update(bookingSettings)
      .set({ enabled: true })
      .where(eq(bookingSettings.restaurantId, tenant.restaurantId));
  }

  const archiveConfirmation = (html: string, tableId: string) =>
    new RegExp(`data-confirmation="([^"]*)"><form[^>]*action="/api/tables/${tableId}/archive"`).exec(
      html,
    )?.[1];

  const savedMessageOf = (html: string, action: string) =>
    new RegExp(`data-saved-message="([^"]*)"><form[^>]*action="${action}"`).exec(html)?.[1];

  it("warns before archiving the last bookable table while booking is on", async () => {
    const seven = await tableIdOf("7");
    await turnBookingOn();

    const confirmation = archiveConfirmation(await screen(TablesScreen), seven);

    expect(confirmation).toContain("Its printed QR code will stop working");
    expect(confirmation).toContain("online booking will switch off");
  });

  it("counts only bookable tables as the last one", async () => {
    const seven = await tableIdOf("7");
    const patio = await tableIdOf("Patio 1");
    await owner.db.update(diningTables).set({ bookable: false }).where(eq(diningTables.id, patio));
    await turnBookingOn();

    const html = await screen(TablesScreen);

    expect(archiveConfirmation(html, seven)).toContain("online booking will switch off");
    expect(archiveConfirmation(html, patio)).not.toContain("switch off");
  });

  it("doesn't warn while another bookable table remains", async () => {
    const seven = await tableIdOf("7");
    await tableIdOf("Patio 1");
    await turnBookingOn();

    expect(archiveConfirmation(await screen(TablesScreen), seven)).not.toContain("switch off");
  });

  it("doesn't warn while booking is off", async () => {
    const seven = await tableIdOf("7");

    expect(archiveConfirmation(await screen(TablesScreen), seven)).not.toContain("switch off");
  });

  it("says so after a table save, in words that survive the page refreshing", async () => {
    const seven = await tableIdOf("7");

    const saved = savedMessageOf(await screen(TablesScreen), `/api/tables/${seven}`);

    expect(saved).toContain("Capacity changes apply to bookings made from now on");
    expect(saved).toContain("online booking has switched off");
  });

  it("says so after a settings save", async () => {
    const saved = savedMessageOf(await screen(SettingsScreen), "/api/restaurant");

    expect(saved).toContain("Settings saved");
    expect(saved).toContain("online booking has switched off");
  });
});

describe("/dashboard/tables/print", () => {
  it("has a card for a table the moment it is added: restaurant, label, instruction and Wi-Fi", async () => {
    await newTable("Patio 1");

    const html = await screen(PrintSheet);

    expect(html).toContain("Mama&#x27;s Kitchen");
    expect(html).toContain("Patio 1");
    expect(html).toContain("Scan to see the menu");
    expect(html).toContain("<p>Wi-Fi: Mamas Guest</p><p>Password: sadza-and-stew</p>");
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
    const margin = Number(/@page\{size:A4;margin:(\d+(?:\.\d+)?)mm\}/.exec(html)?.[1]);
    const card = printMm(cardIn(html).className, "h");
    expect(margin).toBeGreaterThan(0);
    expect(card * 3).toBeLessThanOrEqual(297 - 2 * margin);
    expect(html).toContain("print:gap-0");
  });

  it("fits what's on a card in the card: padding, border, boxes, the QR code and the gaps", async () => {
    await newTable("1");
    const { className, content } = cardIn(await screen(PrintSheet));
    const boxes = [...content.matchAll(/print:h-\[(\d+(?:\.\d+)?)mm\]/g)].map(([, mm]) => Number(mm));
    expect(boxes).toHaveLength(4); // name, label, instruction, Wi-Fi
    expect(content).toContain("w-[5cm]");

    const pixel = 25.4 / 96;
    const used =
      2 * printMm(className, "p") +
      2 * pixel + // the border
      boxes.reduce((sum, mm) => sum + mm, 0) +
      50 + // the QR code
      boxes.length * printMm(className, "gap"); // one between each of the five

    expect(used).toBeLessThanOrEqual(printMm(className, "h"));
  });

  describe("the Wi-Fi details", () => {
    const setWifi = (wifiName: string, wifiPassword: string) =>
      owner.db.update(restaurants).set({ wifiName, wifiPassword }).where(eq(restaurants.id, tenant.restaurantId));

    it("prints the longest real network and password in full, in smaller type", async () => {
      // WPA2's limits: a 32-byte network name and a 63-character passphrase.
      const [name, password] = ["N".repeat(32), "p".repeat(63)];
      await setWifi(name, password);
      await newTable("1");

      const html = await screen(PrintSheet);

      expect(html).toContain(`<p>Wi-Fi: ${name}</p><p>Password: ${password}</p>`);
      expect(cardIn(html).content).toContain("text-[8px]");
      expect(cardIn(html).content).not.toMatch(/line-clamp[^"]*print:h-\[10mm\]/);
    });

    it("steps the type down only as far as it has to", async () => {
      await newTable("1");
      expect(cardIn(await screen(PrintSheet)).content).toContain("text-xs");

      await setWifi("Mamas Guest", "a-passphrase-of-thirty-characters");
      const { content } = cardIn(await screen(PrintSheet));
      expect(content).toContain("text-[10px]");
    });

    it("never prints part of a password: details too long for the card say to ask staff, and the owner is told", async () => {
      const password = "p".repeat(200);
      await setWifi("Mamas Guest", password);
      await newTable("1");

      const html = await screen(PrintSheet);

      expect(html).not.toContain("ppp");
      expect(cardIn(html).content).toContain("Ask staff for the Wi-Fi details");
      expect(html).toMatch(/print:hidden[^>]*>The Wi-Fi details are too long to fit on a card/);
    });

    it("keeps long details that fit once the password is left off", async () => {
      await setWifi("Mamas Guest", "p".repeat(200));
      await newTable("1");

      const html = await screen(() => PrintSheet({ searchParams: Promise.resolve({ nopassword: "1" }) }));

      expect(html).toContain("<p>Wi-Fi: Mamas Guest</p>");
      expect(html).not.toContain("too long to fit");
    });
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
      expect(html).not.toContain("Password: sadza-and-stew");
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
      await newTable("Beta");
      const [alpha, beta] = [await idOf("Alpha"), await idOf("Beta")];
      const html = await render({ scope: "selected", table: [alpha], menu: "1" });
      const ticked = (id: string) => new RegExp(`<input[^>]*name="table"[^>]*checked=""[^>]*value="${id}"`);
      expect(html).toMatch(/<input[^>]*name="menu"[^>]*checked/);
      expect(html).toMatch(/<input[^>]*name="scope"[^>]*checked=""[^>]*value="selected"/);
      expect(html).toMatch(ticked(alpha));
      expect(html).not.toMatch(ticked(beta));
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

describe("/dashboard/menu specials", () => {
  const specialParams = (specialId: string) => ({ params: Promise.resolve({ specialId }) });

  it("offers an owner the list and a form to add one, and none of it to staff", async () => {
    await newItem();

    const asOwner = await screen(MenuScreen);
    session.tenant = { ...tenant, role: "staff" };
    const asStaff = await screen(MenuScreen);

    expect(asOwner).toContain("No specials yet.");
    expect(asOwner).toContain('action="/api/menu/specials"');
    expect(asOwner).toContain("Africa/Harare time");
    expect(asStaff).not.toContain("Specials");
    expect(asStaff).not.toContain("/api/menu/specials");
  });

  it("asks for an item first, since a special needs one", async () => {
    // With no category at all, the specials wait behind the empty menu's one line.
    const empty = await screen(MenuScreen);
    expect(empty).toContain("Dishes, specials and bundles can be added once you have a category.");
    expect(empty).not.toContain('action="/api/menu/specials"');

    await newCategory("Mains");
    const html = await screen(MenuScreen);
    expect(html).toContain("Add an item first.");
    expect(html).not.toContain('action="/api/menu/specials"');
  });

  it("adds a promotion, lists it with its dates and state, and switches it off and on", async () => {
    const itemId = await newItem();

    const added = await addSpecial(
      post("/api/menu/specials", {
        menuItemId: itemId,
        title: "Taco Tuesday",
        priceUsd: "6",
        priceZig: "",
        startDate: "2020-01-01",
        endDate: "2099-12-31",
      }),
    );
    expect(added.status).toBe(303);
    const listed = await screen(MenuScreen);
    expect(listed).toContain("Beef stew");
    expect(listed).toContain("Taco Tuesday");
    expect(listed).toContain("$6.00");
    expect(listed).toContain("2020-01-01 to 2099-12-31");
    expect(listed).toContain("On now");

    const specialId = await specialIdOf(itemId);
    const off = await switchSpecial(
      post(`/api/menu/specials/${specialId}/active`, { active: "false" }, { [FORM_FETCH_HEADER]: "1" }),
      specialParams(specialId),
    );
    expect(off.status).toBe(204);
    const turnedOff = await screen(MenuScreen);
    expect(turnedOff).toContain("Turned off");
    expect(turnedOff).toContain("Turn on");

    await switchSpecial(
      post(`/api/menu/specials/${specialId}/active`, { active: "true" }),
      specialParams(specialId),
    );
    expect(await screen(MenuScreen)).toContain("On now");
  });

  it("lists a badge alone at the normal price, with no end as until turned off", async () => {
    const itemId = await newItem();
    await addSpecial(post("/api/menu/specials", { menuItemId: itemId, title: "Chef's pick" }));

    const html = await screen(MenuScreen);

    expect(html).toContain("Normal price");
    // A blank start is the day it was saved, shown back in the restaurant's zone.
    expect(html).toMatch(/From \d{4}-\d{2}-\d{2}, until turned off/);
  });

  it("refuses a second special in the same dates with a 409 that says why, and adds nothing", async () => {
    const itemId = await newItem();
    await addSpecial(post("/api/menu/specials", { menuItemId: itemId, priceUsd: "6", endDate: "2099-12-31" }));

    const response = await addSpecial(
      post("/api/menu/specials", { menuItemId: itemId, priceUsd: "5", startDate: "2099-12-31" }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error:
        "That item already has an active special in some of those dates. Turn the other off, or change the dates.",
    });
    expect(await owner.db.select().from(specials).where(eq(specials.menuItemId, itemId))).toHaveLength(1);
  });

  it("refuses a blank start with an end date already gone, with a reason, and adds nothing", async () => {
    const itemId = await newItem();

    const response = await addSpecial(
      post("/api/menu/specials", { menuItemId: itemId, priceUsd: "6", endDate: "2020-01-07" }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "That end date has passed. Choose today or later.",
    });
    expect(await owner.db.select().from(specials).where(eq(specials.menuItemId, itemId))).toEqual([]);
  });

  it("answers turning an overlapping special back on with the same 409", async () => {
    const itemId = await newItem();
    await addSpecial(post("/api/menu/specials", { menuItemId: itemId, priceUsd: "6" }));
    const firstId = await specialIdOf(itemId);
    await switchSpecial(post(`/api/menu/specials/${firstId}/active`, { active: "false" }), specialParams(firstId));
    await addSpecial(post("/api/menu/specials", { menuItemId: itemId, priceUsd: "5" }));

    const response = await switchSpecial(
      post(`/api/menu/specials/${firstId}/active`, { active: "true" }),
      specialParams(firstId),
    );

    expect(response.status).toBe(409);
  });

  it.each([
    ["no item", {}, "Choose an item."],
    ["nothing to show", { menuItemId: "x" }, "Enter a badge, a special price, or both."],
    ["a bad price", { menuItemId: "x", priceUsd: "abc" }, "Enter the special USD price as a number, like 6.50."],
    ["a backwards window", { menuItemId: "x", title: "t", startDate: "2030-02-02", endDate: "2030-02-01" }, "The end date can't be before the start date."],
  ])("refuses %s with a reason the form can show", async (_name, fields, error) => {
    const response = await addSpecial(post("/api/menu/specials", fields));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
  });

  it("refuses a switch that is neither on nor off", async () => {
    const itemId = await newItem();
    await addSpecial(post("/api/menu/specials", { menuItemId: itemId, priceUsd: "6" }));
    const specialId = await specialIdOf(itemId);

    const response = await switchSpecial(
      post(`/api/menu/specials/${specialId}/active`, { active: "maybe" }),
      specialParams(specialId),
    );

    expect(response.status).toBe(400);
  });

  it("drops a special from the list when its item is archived", async () => {
    const itemId = await newItem();
    await addSpecial(post("/api/menu/specials", { menuItemId: itemId, title: "Doomed deal", priceUsd: "6" }));
    expect(await screen(MenuScreen)).toContain("Doomed deal");

    await archiveItem(post(`/api/menu/items/${itemId}/archive`), itemParams(itemId));

    expect(await screen(MenuScreen)).not.toContain("Doomed deal");
  });

  it("changes nothing about the item's own price", async () => {
    const itemId = await newItem();
    await addSpecial(post("/api/menu/specials", { menuItemId: itemId, priceUsd: "1" }));

    const [row] = await owner.db.select().from(menuItems).where(eq(menuItems.id, itemId));

    expect(row.priceUsd).toBe("8.50");
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

  it("flows a regenerated token into the selected-tables sheet", async () => {
    const id = await tableIdOf("7");
    const old = await tokenOfTable(id);
    await regenerateTable(post(`/api/tables/${id}/regenerate`), tableParams(id));

    const fresh = await tokenOfTable(id);
    const html = await screen(() => PrintSheet({ searchParams: Promise.resolve({ scope: "selected", table: [id] }) }));
    const url = (token: string) => qrSvg(tableCodeUrl(getEnv().NEXT_PUBLIC_APP_URL, token));
    expect(html).toContain((await url(fresh)).trim());
    expect(html).not.toContain((await url(old)).trim());
  });

  it("drops an archived table from the selected-tables sheet, though its id is still ticked", async () => {
    const gone = await tableIdOf("Gone");
    const kept = await tableIdOf("Kept");
    await archive(post(`/api/tables/${gone}/archive`), tableParams(gone));

    const html = await screen(() =>
      PrintSheet({ searchParams: Promise.resolve({ scope: "selected", table: [gone, kept] }) }),
    );

    expect(html).toContain(">Kept</p>");
    expect(html).not.toContain(">Gone</p>");
  });

  it.each(["not-a-uuid", crypto.randomUUID()])("is a 404 for a table that isn't there: %s", async (id) => {
    expect(await statusOf(() => regenerateTable(post(`/api/tables/${id}/regenerate`), tableParams(id)))).toBe(404);
  });
});
