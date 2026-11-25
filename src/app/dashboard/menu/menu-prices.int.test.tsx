import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as addBundle } from "@/app/api/menu/bundles/route";
import { POST as renameCategory } from "@/app/api/menu/categories/[categoryId]/route";
import { POST as addCategory } from "@/app/api/menu/categories/route";
import { POST as setRate } from "@/app/api/menu/exchange-rate/route";
import { POST as editItem } from "@/app/api/menu/items/[itemId]/route";
import { POST as addItem } from "@/app/api/menu/items/route";
import { POST as addSpecial } from "@/app/api/menu/specials/route";
import { categories, exchangeRates, menuItems, restaurants, specials, staff } from "@/db/schema";
import type { TenantContext } from "@/lib/tenant";
import { openOwnerDatabase, testDatabaseSettings } from "../../../../test/integration/database";
import { MenuScreen } from "./menu-screen";

/**
 * Menu prices that deserve a second look (issue #112): specials above the normal
 * price, zero prices, big rate jumps and duplicate names. A save that needs a
 * yes answers 409 with `confirm.warnings` and saves nothing, until the post
 * carries `confirmed=1` (what ActionForm sends after its dialog).
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
    slug: `prices-${restaurantId}`,
    menuToken: restaurantId,
    currencyMode: "both",
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

const post = (path: string, fields: Record<string, string> = {}) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return new NextRequest(new URL(path, "http://localhost:3000"), { method: "POST", body });
};
const yes = { confirmed: "1" };

const newCategory = async (name = "Mains") => {
  const [{ id }] = await owner.db
    .insert(categories)
    .values({ restaurantId: tenant.restaurantId, name })
    .returning({ id: categories.id });
  return id;
};
const newItem = async (categoryId: string, name: string, priceUsd: string | null, priceZig: string | null = null) => {
  const [{ id }] = await owner.db
    .insert(menuItems)
    .values({ restaurantId: tenant.restaurantId, categoryId, name, priceUsd, priceZig })
    .returning({ id: menuItems.id });
  return id;
};
const setRateTo = (usdToZig: string) =>
  owner.db.insert(exchangeRates).values({ restaurantId: tenant.restaurantId, usdToZig, setBy: tenant.staffId });
const specialsOf = () => owner.db.select().from(specials).where(eq(specials.restaurantId, tenant.restaurantId));
const itemNames = async () =>
  (await owner.db.select({ name: menuItems.name }).from(menuItems).where(eq(menuItems.restaurantId, tenant.restaurantId))).map(
    (row) => row.name,
  );
const screen = async () => renderToStaticMarkup(await MenuScreen());
const itemParams = (itemId: string) => ({ params: Promise.resolve({ itemId }) });
const categoryParams = (categoryId: string) => ({ params: Promise.resolve({ categoryId }) });

const asked = async (response: Response) => {
  expect(response.status).toBe(409);
  const body = await response.json();
  expect(body.error).toBe(body.confirm.warnings.join(" "));
  return body.confirm.warnings as string[];
};

describe("a special above the normal price", () => {
  it("is refused with both prices in the reason, and saves nothing", async () => {
    const itemId = await newItem(await newCategory(), "Burger", "19.50");

    const response = await addSpecial(post("/api/menu/specials", { menuItemId: itemId, priceUsd: "25" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error:
        "The special USD price ($25.00) is above the normal price ($19.50). A special has to be lower, or leave the price blank for a badge alone.",
    });
    expect(await specialsOf()).toEqual([]);
  });

  it("is refused in ZiG against a fixed ZiG price, and against a calculated one", async () => {
    const category = await newCategory();
    const fixed = await newItem(category, "Fixed", null, "500");
    const calculated = await newItem(category, "Calculated", "10");
    await setRateTo("26.2");

    const overFixed = await addSpecial(post("/api/menu/specials", { menuItemId: fixed, priceZig: "501" }));
    const overCalculated = await addSpecial(
      post("/api/menu/specials", { menuItemId: calculated, priceZig: "271" }),
    );

    expect(overFixed.status).toBe(400);
    expect((await overFixed.json()).error).toContain("(ZiG 501) is above the normal price (ZiG 500)");
    expect(overCalculated.status).toBe(400);
    expect((await overCalculated.json()).error).toContain("(ZiG 271) is above the normal price (ZiG 270)");
  });

  it("is refused when a USD special's calculated ZiG price is above the fixed one", async () => {
    const itemId = await newItem(await newCategory(), "Burger", "10", "200");
    await setRateTo("26.2");

    const response = await addSpecial(post("/api/menu/specials", { menuItemId: itemId, priceUsd: "9" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error:
        "At the current rate this special's ZiG price is calculated as ZiG 240, above the normal price (ZiG 200). Enter a special ZiG price too, or lower the special USD price.",
    });
    expect(await specialsOf()).toEqual([]);
    // Typing both prices, or a USD price low enough for both, is fine.
    expect(
      (await addSpecial(post("/api/menu/specials", { menuItemId: itemId, priceUsd: "9", priceZig: "180" }))).status,
    ).toBe(303);
    await owner.db.update(specials).set({ active: false });
    expect((await addSpecial(post("/api/menu/specials", { menuItemId: itemId, priceUsd: "7.60" }))).status).toBe(303);
  });

  it("is refused when a ZiG special's calculated USD price is above the fixed one", async () => {
    const itemId = await newItem(await newCategory(), "Burger", "5", "500");
    await setRateTo("26.2");

    const response = await addSpecial(post("/api/menu/specials", { menuItemId: itemId, priceZig: "400" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error:
        "At the current rate this special's USD price is calculated as $15.27, above the normal price ($5.00). Enter a special USD price too, or lower the special ZiG price.",
    });
    expect(await specialsOf()).toEqual([]);
  });

  it("doesn't refuse an equal or lower special because rounding up lifts the calculated side", async () => {
    const category = await newCategory();
    // ZiG 210 is $8.02, and $8.02 back is ZiG 220. $8 is ZiG 210, and that back is $8.02.
    const zigOnly = await newItem(category, "ZiG only", null, "210");
    const usdOnly = await newItem(category, "USD only", "8");
    await setRateTo("26.2");

    for (const fields of [
      { menuItemId: zigOnly, priceUsd: "8.02" },
      { menuItemId: zigOnly, priceUsd: "7.50" },
      { menuItemId: usdOnly, priceZig: "210" },
      { menuItemId: usdOnly, priceZig: "200" },
    ] as Record<string, string>[]) {
      expect((await addSpecial(post("/api/menu/specials", fields))).status).toBe(303);
      await owner.db.update(specials).set({ active: false });
    }
    // Above the calculated normal price is still above.
    const above = await addSpecial(post("/api/menu/specials", { menuItemId: zigOnly, priceUsd: "8.03" }));
    expect((await above.json()).error).toContain("($8.03) is above the normal price ($8.02)");
  });

  it("tells ZiG-only items, and exact twins, apart in the picker", async () => {
    const drinks = await newCategory("Drinks");
    await newItem(drinks, "Soda", null, "30");
    await newItem(drinks, "Soda", null, "45");
    await newItem(drinks, "Juice", "2");
    await newItem(drinks, "Juice", "2");

    const html = (await screen()).replaceAll("<!-- -->", "");
    const options = [...html.matchAll(/<option[^>]*>([^<]* · Drinks · [^<]*)<\/option>/g)].map((m) => m[1]);

    expect(options.sort()).toEqual([
      "Juice · Drinks · $2.00 · 1 of 2",
      "Juice · Drinks · $2.00 · 2 of 2",
      "Soda · Drinks · ZiG 30",
      "Soda · Drinks · ZiG 45",
    ]);
  });

  it("takes a lower price, an equal one, and a badge alone", async () => {
    const itemId = await newItem(await newCategory(), "Burger", "19.50");

    for (const fields of [{ priceUsd: "15" }, { title: "Chef's pick" }] as Record<string, string>[]) {
      expect((await addSpecial(post("/api/menu/specials", { menuItemId: itemId, ...fields }))).status).toBe(303);
      await owner.db.update(specials).set({ active: false });
    }
    expect(
      (await addSpecial(post("/api/menu/specials", { menuItemId: itemId, priceUsd: "19.50" }))).status,
    ).toBe(303);
  });

  it("is not compared against a calculated price before any rate is set", async () => {
    const itemId = await newItem(await newCategory(), "Burger", "10");
    const response = await addSpecial(post("/api/menu/specials", { menuItemId: itemId, priceZig: "99999" }));
    expect(response.status).toBe(303);
  });

  it("shows the item's normal price beside the picker, and tells equal names apart (the first item, Bar before Drinks)", async () => {
    const drinks = await newCategory("Drinks");
    const bar = await newCategory("Bar");
    await newItem(drinks, "Soda", "1");
    await newItem(bar, "Soda", "2");
    await setRateTo("26.2");

    const html = (await screen()).replaceAll("<!-- -->", "");

    expect(html).toContain("Soda · Drinks · $1.00 · ZiG 30 (calculated)");
    expect(html).toContain("Soda · Bar · $2.00 · ZiG 60 (calculated)");
    expect(html).toContain("Normal price: $2.00 · ZiG 60 (calculated)");
  });
});

describe("a zero price", () => {
  const item = (categoryId: string, fields: Record<string, string> = {}) => ({
    name: "Water",
    description: "",
    priceUsd: "0",
    categoryId,
    ...fields,
  });

  it("asks before adding an item, and adds it once confirmed", async () => {
    const categoryId = await newCategory();

    const warnings = await asked(await addItem(post("/api/menu/items", item(categoryId))));
    expect(warnings).toEqual(["The USD price is 0, so this item would be free."]);
    expect(await itemNames()).toEqual([]);

    expect((await addItem(post("/api/menu/items", { ...item(categoryId), ...yes }))).status).toBe(303);
    expect(await itemNames()).toEqual(["Water"]);
  });

  it("names both currencies when both are zero", async () => {
    const categoryId = await newCategory();
    const warnings = await asked(
      await addItem(post("/api/menu/items", item(categoryId, { priceZig: "0.00" }))),
    );
    expect(warnings).toEqual(["The USD and ZiG price is 0, so this item would be free."]);
  });

  it("asks when an edit makes a price zero, but not when it was already zero", async () => {
    const categoryId = await newCategory();
    const paid = await newItem(categoryId, "Tea", "1");
    const free = await newItem(categoryId, "Bread", "0");
    const edit = (name: string, priceUsd: string) => ({
      name,
      description: "",
      priceUsd,
      categoryId,
      sortOrder: "0",
    });

    await asked(await editItem(post(`/api/menu/items/${paid}`, edit("Tea", "0")), itemParams(paid)));
    expect(
      (await editItem(post(`/api/menu/items/${free}`, edit("Bread", "0")), itemParams(free))).status,
    ).toBe(303);
    expect(
      (await editItem(post(`/api/menu/items/${paid}`, { ...edit("Tea", "0"), ...yes }), itemParams(paid))).status,
    ).toBe(303);
  });

  it("asks before adding a free special or a free bundle", async () => {
    const categoryId = await newCategory();
    const itemId = await newItem(categoryId, "Burger", "5");

    const special = await asked(await addSpecial(post("/api/menu/specials", { menuItemId: itemId, priceUsd: "0" })));
    expect(special).toEqual(["The USD price is 0, so this special would be free."]);
    expect(await specialsOf()).toEqual([]);
    expect(
      (await addSpecial(post("/api/menu/specials", { menuItemId: itemId, priceUsd: "0", ...yes }))).status,
    ).toBe(303);

    const bundle = {
      name: "Combo",
      description: "Burger + chips",
      priceUsd: "0",
      categoryId,
    };
    await asked(await addBundle(post("/api/menu/bundles", bundle)));
    expect((await addBundle(post("/api/menu/bundles", { ...bundle, ...yes }))).status).toBe(303);
  });
});

describe("a big change of exchange rate", () => {
  const rates = async () =>
    (await owner.db.select().from(exchangeRates).where(eq(exchangeRates.restaurantId, tenant.restaurantId))).map(
      (row) => row.usdToZig,
    );

  it("asks about 26.2 to 2620, and saves nothing until confirmed", async () => {
    await setRateTo("26.2");

    const warnings = await asked(await setRate(post("/api/menu/exchange-rate", { usdToZig: "2620" })));
    expect(warnings).toEqual([
      "This changes the rate from 26.2 to 2620, up 9,900%. Every calculated ZiG price changes with it, at once.",
    ]);
    expect(await rates()).toEqual(["26.2"]);

    expect((await setRate(post("/api/menu/exchange-rate", { usdToZig: "2620", ...yes }))).status).toBe(303);
    expect((await rates()).sort()).toEqual(["26.2", "2620"]);
  });

  it("asks about a fall by more than half too", async () => {
    await setRateTo("26.2");
    await asked(await setRate(post("/api/menu/exchange-rate", { usdToZig: "2.62" })));
  });

  it("lets an ordinary change and the first rate through", async () => {
    expect((await setRate(post("/api/menu/exchange-rate", { usdToZig: "26.2" }))).status).toBe(303);
    expect((await setRate(post("/api/menu/exchange-rate", { usdToZig: "28" }))).status).toBe(303);
    expect(await rates()).toHaveLength(2);
  });
});

describe("duplicate names", () => {
  const fields = (categoryId: string, name: string) => ({ name, description: "", priceUsd: "5", categoryId });

  it("asks before a second item of the same name, whatever its case, in one category", async () => {
    const categoryId = await newCategory("Mains");
    await newItem(categoryId, "Beef Stew", "8");

    const warnings = await asked(await addItem(post("/api/menu/items", fields(categoryId, " beef stew "))));
    expect(warnings).toEqual([`Mains already has an item called "Beef Stew". Two with one name are hard to tell apart.`]);
    expect(await itemNames()).toEqual(["Beef Stew"]);

    expect((await addItem(post("/api/menu/items", { ...fields(categoryId, "beef stew"), ...yes }))).status).toBe(303);
    expect(await itemNames()).toHaveLength(2);
  });

  it("doesn't ask about the same name in another category, or one that is archived", async () => {
    const mains = await newCategory("Mains");
    const sides = await newCategory("Sides");
    await newItem(mains, "Chips", "2");
    const gone = await newItem(sides, "Rice", "2");
    await owner.db.update(menuItems).set({ archivedAt: new Date() }).where(eq(menuItems.id, gone));

    expect((await addItem(post("/api/menu/items", fields(sides, "Chips")))).status).toBe(303);
    expect((await addItem(post("/api/menu/items", fields(sides, "Rice")))).status).toBe(303);
  });

  it("asks when an edit renames onto, or moves onto, a name, and not when it only keeps its own", async () => {
    const mains = await newCategory("Mains");
    const sides = await newCategory("Sides");
    await newItem(mains, "Chips", "2");
    const rice = await newItem(mains, "Rice", "2");
    const edit = (categoryId: string, name: string) => ({ ...fields(categoryId, name), sortOrder: "0" });

    await asked(await editItem(post(`/api/menu/items/${rice}`, edit(mains, "chips")), itemParams(rice)));
    // Moving Chips-named rice into Sides is fine: Sides has no Chips.
    expect((await editItem(post(`/api/menu/items/${rice}`, edit(sides, "Rice")), itemParams(rice))).status).toBe(303);
    // Saving it as it is asks nothing, even with a twin made since.
    await newItem(sides, "Rice", "3");
    expect((await editItem(post(`/api/menu/items/${rice}`, edit(sides, "Rice")), itemParams(rice))).status).toBe(303);
  });

  it("asks before a duplicate bundle", async () => {
    const categoryId = await newCategory();
    await newItem(categoryId, "Combo", "9");
    await asked(await addBundle(post("/api/menu/bundles", { ...fields(categoryId, "Combo"), description: "Burger + chips" })));
  });

  it("asks before a second category of the same name, and before renaming onto one", async () => {
    const mains = await newCategory("Mains");
    const drinks = await newCategory("Drinks");

    // Changing only its own case is not a duplicate of itself.
    expect(
      (await renameCategory(post(`/api/menu/categories/${mains}`, { name: "MAINS" }), categoryParams(mains))).status,
    ).toBe(303);

    await asked(await renameCategory(post(`/api/menu/categories/${drinks}`, { name: "mains" }), categoryParams(drinks)));

    const added = await asked(await addCategory(post("/api/menu/categories", { name: "mains" })));
    expect(added).toEqual([`There is already a category called "MAINS". Two with one name are hard to tell apart.`]);
    expect((await addCategory(post("/api/menu/categories", { name: "mains", ...yes }))).status).toBe(303);
  });
});
