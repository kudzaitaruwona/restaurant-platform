import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog, categories, menuItems, restaurants, specials } from "@/db/schema";
import {
  openOwnerDatabase,
  testDatabaseSettings,
} from "../../test/integration/database";
import { createBundle, DEFAULT_BUNDLE_BADGE, type NewBundle } from "./bundles";
import { archiveMenuItem, getMenu, reorderCategories, setItemAvailability, updateMenuItem } from "./menu";
import { menuTag } from "./menu-cache";
import {
  createSpecial,
  FINISHED_SPECIALS_LISTED,
  listSpecials,
  setSpecialActive,
} from "./specials";

const revalidateTag = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidateTag }));

/**
 * Bundles against a real Postgres, as app_tenant, so everything here also holds
 * under RLS. What matters is where a `special_only` item shows: the customer's
 * view (getMenu as the page calls it) and the owner's (`forEditor`).
 */
const owner = openOwnerDatabase();
const created: string[] = [];

async function newRestaurant(timezone = "Africa/Harare") {
  const restaurantId = crypto.randomUUID();
  await owner.db.insert(restaurants).values({
    id: restaurantId,
    name: "Mama's Kitchen",
    slug: `bundles-lib-${restaurantId}`,
    menuToken: `bundles-lib-${restaurantId}`,
    currencyMode: "usd_only",
    timezone,
  });
  created.push(restaurantId);
  const [category] = await owner.db
    .insert(categories)
    .values({ restaurantId, name: "Combos", sortOrder: 0 })
    .returning({ id: categories.id });
  return { restaurantId, categoryId: category.id };
}

const bundle = (categoryId: string, fields: Partial<NewBundle> = {}): NewBundle => ({
  name: "Burger + chips + drink",
  description: "Beef burger, chips and a soft drink.",
  priceUsd: "9.50",
  priceZig: null,
  categoryId,
  title: null,
  startDate: null,
  endDate: null,
  ...fields,
});

const bundleRows = (restaurantId: string) =>
  owner.db
    .select()
    .from(menuItems)
    .where(and(eq(menuItems.restaurantId, restaurantId), eq(menuItems.visibility, "special_only")));

const itemRows = (restaurantId: string) =>
  owner.db.select().from(menuItems).where(eq(menuItems.restaurantId, restaurantId));

const specialRows = (restaurantId: string) =>
  owner.db.select().from(specials).where(eq(specials.restaurantId, restaurantId));

const at = (iso: string) => new Date(iso);

/** Everything the customer's page can draw from, as a flat list of names. */
const customerSees = async (tenant: { restaurantId: string }, now: Date) => {
  const menu = await getMenu(tenant, now);
  return {
    inCategories: menu.categories.flatMap((category) => category.items.map((item) => item.name)),
    bundles: menu.bundles.map((item) => item.name),
  };
};

const ownerSees = async (tenant: { restaurantId: string }, now: Date) =>
  (await getMenu(tenant, now, { forEditor: true })).categories
    .flatMap((category) => category.items)
    .map(({ name }) => name);

beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});

beforeEach(() => revalidateTag.mockClear());

afterAll(async () => {
  await owner.db.delete(auditLog).where(inArray(auditLog.restaurantId, created));
  await owner.db.delete(specials).where(inArray(specials.restaurantId, created));
  await owner.db.delete(menuItems).where(inArray(menuItems.restaurantId, created));
  await owner.db.delete(categories).where(inArray(categories.restaurantId, created));
  await owner.db.delete(restaurants).where(inArray(restaurants.id, created));
  await owner.pool.end();
  vi.unstubAllEnvs();
});

describe("one form makes the item and its special", () => {
  it("creates a special_only item with its description and prices, and a special on it", async () => {
    const tenant = await newRestaurant();

    expect(
      await createBundle(tenant, bundle(tenant.categoryId, { title: "Lunch combo", startDate: "2030-03-01", endDate: "2030-03-07" })),
    ).toBe("saved");

    const [item] = await bundleRows(tenant.restaurantId);
    expect(item).toMatchObject({
      name: "Burger + chips + drink",
      description: "Beef burger, chips and a soft drink.",
      priceUsd: "9.50",
      categoryId: tenant.categoryId,
      visibility: "special_only",
      available: true,
      archivedAt: null,
    });
    const [special] = await specialRows(tenant.restaurantId);
    expect(special).toMatchObject({ menuItemId: item.id, title: "Lunch combo", active: true });
    // Harare is UTC+2, and the end date is inclusive: the same rule as a promotion.
    expect(special.startsAt).toEqual(at("2030-02-28T22:00:00Z"));
    expect(special.endsAt).toEqual(at("2030-03-07T22:00:00Z"));
  });

  it("gives the special a badge when the owner left it blank, because a special needs one", async () => {
    const tenant = await newRestaurant();
    await createBundle(tenant, bundle(tenant.categoryId));
    expect((await specialRows(tenant.restaurantId))[0].title).toBe(DEFAULT_BUNDLE_BADGE);
  });

  it("puts the bundle at the end of its category", async () => {
    const tenant = await newRestaurant();
    await owner.db.insert(menuItems).values({
      restaurantId: tenant.restaurantId,
      categoryId: tenant.categoryId,
      name: "Regular",
      priceUsd: "1",
      sortOrder: 4,
    });
    await createBundle(tenant, bundle(tenant.categoryId));
    expect((await bundleRows(tenant.restaurantId))[0].sortOrder).toBe(5);
  });

  it("with a blank start, opens at the moment of saving, so a special that is over can't block it", async () => {
    const tenant = await newRestaurant();
    await createBundle(tenant, bundle(tenant.categoryId));
    const [special] = await specialRows(tenant.restaurantId);
    expect(Math.abs(special.startsAt!.getTime() - Date.now())).toBeLessThan(60_000);
    expect(special.endsAt).toBeNull();
    expect((await customerSees(tenant, new Date())).bundles).toEqual(["Burger + chips + drink"]);
  });

  it("with a blank start and an end date already gone, makes neither the item nor the special", async () => {
    const tenant = await newRestaurant();

    expect(await createBundle(tenant, bundle(tenant.categoryId, { endDate: "2020-01-01" }))).toBe("already_over");

    expect(await itemRows(tenant.restaurantId)).toEqual([]);
    expect(await specialRows(tenant.restaurantId)).toEqual([]);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("answers no_such_category, and makes nothing, for another restaurant's, an archived or an unknown category", async () => {
    const tenant = await newRestaurant();
    const other = await newRestaurant();
    const [archived] = await owner.db
      .insert(categories)
      .values({ restaurantId: tenant.restaurantId, name: "Old", archivedAt: new Date() })
      .returning({ id: categories.id });

    for (const categoryId of [other.categoryId, archived.id, crypto.randomUUID(), "not-a-uuid"]) {
      expect(await createBundle(tenant, bundle(categoryId))).toBe("no_such_category");
    }

    expect(await itemRows(tenant.restaurantId)).toEqual([]);
    expect(await itemRows(other.restaurantId)).toEqual([]);
    expect(await specialRows(tenant.restaurantId)).toEqual([]);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("revalidates this restaurant's menu once, after the commit", async () => {
    const tenant = await newRestaurant();

    expect(await createBundle(tenant, bundle(tenant.categoryId))).toBe("saved");

    expect(revalidateTag).toHaveBeenCalledExactlyOnceWith(menuTag(tenant.restaurantId), { expire: 0 });
    // After the commit: by now the page can read what it was told about.
    expect(await bundleRows(tenant.restaurantId)).toHaveLength(1);
  });
});

describe("a bundle shows only inside its special's window", () => {
  const window = { startDate: "2030-03-01", endDate: "2030-03-07" };

  it("is invisible before the window, live through the last day, and invisible after", async () => {
    const tenant = await newRestaurant();
    await createBundle(tenant, bundle(tenant.categoryId, window));

    // 23:59:59 on 28 February in Harare, then midnight.
    expect((await customerSees(tenant, at("2030-02-28T21:59:59Z"))).bundles).toEqual([]);
    expect((await customerSees(tenant, at("2030-02-28T22:00:00Z"))).bundles).toEqual(["Burger + chips + drink"]);
    expect((await customerSees(tenant, at("2030-03-07T21:59:59Z"))).bundles).toEqual(["Burger + chips + drink"]);
    expect((await customerSees(tenant, at("2030-03-07T22:00:00Z"))).bundles).toEqual([]);
  });

  it("is in no category, inside the window or out of it", async () => {
    const tenant = await newRestaurant();
    await createBundle(tenant, bundle(tenant.categoryId, window));

    for (const now of ["2030-02-01T00:00:00Z", "2030-03-03T10:00:00Z", "2030-04-01T00:00:00Z"]) {
      expect((await customerSees(tenant, at(now))).inCategories).toEqual([]);
    }
  });

  it("carries its special, so the page can badge it", async () => {
    const tenant = await newRestaurant();
    await createBundle(tenant, bundle(tenant.categoryId, { ...window, title: "Lunch combo" }));

    const { bundles } = await getMenu(tenant, at("2030-03-03T10:00:00Z"));

    expect(bundles).toMatchObject([{ name: "Burger + chips + drink", special: { title: "Lunch combo" } }]);
  });

  it("is invisible while its special is turned off, and back when it is turned on", async () => {
    const tenant = await newRestaurant();
    await createBundle(tenant, bundle(tenant.categoryId));
    const [special] = await specialRows(tenant.restaurantId);
    const now = new Date(Date.now() + 1000);

    expect(await setSpecialActive(tenant, special.id, false)).toBe("saved");
    expect((await customerSees(tenant, now)).bundles).toEqual([]);
    expect((await customerSees(tenant, now)).inCategories).toEqual([]);
    expect(await ownerSees(tenant, now)).toEqual(["Burger + chips + drink"]);

    expect(await setSpecialActive(tenant, special.id, true)).toBe("saved");
    expect((await customerSees(tenant, now)).bundles).toEqual(["Burger + chips + drink"]);
  });

  it("is invisible with no special at all: visibility alone never shows an item", async () => {
    const tenant = await newRestaurant();
    await owner.db.insert(menuItems).values({
      restaurantId: tenant.restaurantId,
      categoryId: tenant.categoryId,
      name: "Orphan bundle",
      priceUsd: "5",
      visibility: "special_only",
    });
    expect(await customerSees(tenant, new Date())).toEqual({ inCategories: [], bundles: [] });
  });

  it("is never another restaurant's: a live bundle shows only to its own", async () => {
    const tenant = await newRestaurant();
    const other = await newRestaurant();
    await createBundle(tenant, bundle(tenant.categoryId));
    const now = new Date(Date.now() + 1000);

    expect((await customerSees(other, now)).bundles).toEqual([]);
    expect(await ownerSees(other, now)).toEqual([]);
  });
});

describe("the owner's editor still has a bundle that is out of its window", () => {
  it("lists it in its category before, after and during, with the special only while live", async () => {
    const tenant = await newRestaurant();
    await createBundle(tenant, bundle(tenant.categoryId, { startDate: "2030-03-01", endDate: "2030-03-07" }));

    for (const now of ["2030-02-01T00:00:00Z", "2030-03-03T10:00:00Z", "2030-04-01T00:00:00Z"]) {
      expect(await ownerSees(tenant, at(now))).toEqual(["Burger + chips + drink"]);
    }
    const out = (await getMenu(tenant, at("2030-04-01T00:00:00Z"), { forEditor: true })).categories[0].items[0];
    expect(out).toMatchObject({ visibility: "special_only", special: null });
    const during = (await getMenu(tenant, at("2030-03-03T10:00:00Z"), { forEditor: true })).categories[0].items[0];
    expect(during.special).not.toBeNull();
  });

  it("leaves `bundles` empty, so nothing is listed twice", async () => {
    const tenant = await newRestaurant();
    await createBundle(tenant, bundle(tenant.categoryId));
    expect((await getMenu(tenant, new Date(Date.now() + 1000), { forEditor: true })).bundles).toEqual([]);
  });

  it("is what the customer's view does without being asked: the default hides it", async () => {
    const tenant = await newRestaurant();
    await createBundle(tenant, bundle(tenant.categoryId, { startDate: "2030-03-01", endDate: "2030-03-07" }));
    const menu = await getMenu(tenant, at("2030-04-01T00:00:00Z"));
    expect(menu.categories.flatMap((category) => category.items)).toEqual([]);
  });
});

describe("what else the owner can do to a bundle", () => {
  it("archiving it takes it off both views, and its special stays in the table and out of the list", async () => {
    const tenant = await newRestaurant();
    await createBundle(tenant, bundle(tenant.categoryId));
    const [item] = await bundleRows(tenant.restaurantId);
    const now = new Date(Date.now() + 1000);

    expect(await archiveMenuItem(tenant, item.id)).toBe("archived");

    expect(await customerSees(tenant, now)).toEqual({ inCategories: [], bundles: [] });
    expect(await ownerSees(tenant, now)).toEqual([]);
    expect(await specialRows(tenant.restaurantId)).toHaveLength(1);
    expect(await listSpecials(tenant, now)).toEqual([]);
  });

  it("marking it sold out keeps it in the live bundles, with its flag, and back again", async () => {
    const tenant = await newRestaurant();
    await createBundle(tenant, bundle(tenant.categoryId));
    const [item] = await bundleRows(tenant.restaurantId);
    const now = new Date(Date.now() + 1000);

    expect(await setItemAvailability(tenant, item.id, false)).toBe("saved");
    expect((await getMenu(tenant, now)).bundles).toMatchObject([{ name: item.name, available: false }]);

    expect(await setItemAvailability(tenant, item.id, true)).toBe("saved");
    expect((await getMenu(tenant, now)).bundles).toMatchObject([{ available: true }]);
  });

  it("editing it never changes its visibility", async () => {
    const tenant = await newRestaurant();
    await createBundle(tenant, bundle(tenant.categoryId));
    const [item] = await bundleRows(tenant.restaurantId);

    expect(
      await updateMenuItem(tenant, item.id, {
        name: "Bigger bundle",
        description: "More of it.",
        priceUsd: "12",
        priceZig: null,
        categoryId: tenant.categoryId,
        sortOrder: 3,
      }),
    ).toBe("saved");

    expect((await bundleRows(tenant.restaurantId))[0]).toMatchObject({ name: "Bigger bundle", visibility: "special_only" });
    expect((await customerSees(tenant, new Date(Date.now() + 1000))).inCategories).toEqual([]);
  });

  it("moves with its category: reordering categories reorders the live bundles", async () => {
    const tenant = await newRestaurant();
    const [second] = await owner.db
      .insert(categories)
      .values({ restaurantId: tenant.restaurantId, name: "Drinks", sortOrder: 1 })
      .returning({ id: categories.id });
    await createBundle(tenant, bundle(tenant.categoryId, { name: "First bundle" }));
    await createBundle(tenant, bundle(second.id, { name: "Second bundle" }));
    const now = new Date(Date.now() + 1000);
    const names = async () => (await getMenu(tenant, now)).bundles.map(({ name }) => name);

    expect(await names()).toEqual(["First bundle", "Second bundle"]);
    expect(await reorderCategories(tenant, [second.id, tenant.categoryId])).toBe("saved");
    expect(await names()).toEqual(["Second bundle", "First bundle"]);
    expect((await customerSees(tenant, now)).inCategories).toEqual([]);
  });

  it("can be given another window as a promotion would, and D-05 holds for it", async () => {
    const tenant = await newRestaurant();
    await createBundle(tenant, bundle(tenant.categoryId, { startDate: "2030-03-01", endDate: "2030-03-07" }));
    const [item] = await bundleRows(tenant.restaurantId);
    const promo = (startDate: string, endDate: string) => ({
      menuItemId: item.id,
      title: "Again",
      priceUsd: null,
      priceZig: null,
      startDate,
      endDate,
    });

    expect(await createSpecial(tenant, promo("2030-03-05", "2030-03-09"))).toBe("overlap");
    expect(await createSpecial(tenant, promo("2030-03-08", "2030-03-09"))).toBe("saved");
    expect((await customerSees(tenant, at("2030-03-08T10:00:00Z"))).bundles).toEqual(["Burger + chips + drink"]);
  });
});

describe("the owner's list of specials", () => {
  it("marks a bundle's special as one", async () => {
    const tenant = await newRestaurant();
    await createBundle(tenant, bundle(tenant.categoryId));

    expect(await listSpecials(tenant, new Date(Date.now() + 1000))).toMatchObject([
      { itemName: "Burger + chips + drink", itemVisibility: "special_only", status: "live" },
    ]);
  });

  it("caps a bundle's finished specials with the rest, and the bundle stays in the editor when its special is past the cap", async () => {
    const tenant = await newRestaurant();
    await createBundle(tenant, bundle(tenant.categoryId, { startDate: "2030-01-01", endDate: "2030-01-02" }));
    const [{ id: pieId }] = await owner.db
      .insert(menuItems)
      .values({ restaurantId: tenant.restaurantId, categoryId: tenant.categoryId, name: "Pie", priceUsd: "5" })
      .returning({ id: menuItems.id });
    await owner.db.insert(specials).values(
      Array.from({ length: FINISHED_SPECIALS_LISTED }, (_, n) => ({
        restaurantId: tenant.restaurantId,
        menuItemId: pieId,
        title: `Pie week ${n}`,
        specialPriceUsd: "4",
        startsAt: new Date(Date.UTC(2031, 0, 1 + n * 2)),
        endsAt: new Date(Date.UTC(2031, 0, 2 + n * 2)),
      })),
    );
    const now = new Date("2032-01-01T00:00:00Z");

    const listed = await listSpecials(tenant, now);

    expect(listed).toHaveLength(FINISHED_SPECIALS_LISTED);
    expect(listed.map(({ itemName }) => itemName)).not.toContain("Burger + chips + drink");
    expect(await ownerSees(tenant, now)).toContain("Burger + chips + drink");
  });
});
