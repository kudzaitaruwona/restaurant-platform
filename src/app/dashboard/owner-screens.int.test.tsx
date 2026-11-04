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
import { POST as saveSettings } from "@/app/api/restaurant/route";
import { POST as deactivate } from "@/app/api/staff/[staffId]/deactivate/route";
import { POST as changeRole } from "@/app/api/staff/[staffId]/role/route";
import { POST as addStaff } from "@/app/api/staff/route";
import { auditLog, categories, exchangeRates, menuItems, restaurants, specials, staff } from "@/db/schema";
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

// Photos go through the storage interface, faked so nothing reaches R2.
vi.mock("@/lib/storage", () => ({
  uploadImage: async (key: string) => ({ key, url: `https://cdn.example.test/${key}` }),
  deleteImage: async () => {},
  getUrl: (key: string) => `https://cdn.example.test/${key}`,
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
