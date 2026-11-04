import { eq, inArray } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { auditLog, categories, menuItems, restaurants } from "@/db/schema";
import {
  openOwnerDatabase,
  testDatabaseSettings,
} from "../../test/integration/database";
import {
  addCategory,
  addMenuItem,
  archiveCategory,
  archiveMenuItem,
  getMenu,
  renameCategory,
  reorderCategories,
  setItemAvailability,
  updateMenuItem,
} from "./menu";
import { menuTag } from "./menu-cache";

const revalidateTag = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidateTag }));

/** Runs as app_tenant, so everything here also holds under RLS. */
const owner = openOwnerDatabase();
const created: string[] = [];

async function newRestaurant(name = "Mama's Kitchen") {
  const restaurantId = crypto.randomUUID();
  await owner.db.insert(restaurants).values({
    id: restaurantId,
    name,
    slug: `menu-${restaurantId}`,
    menuToken: `menu-${restaurantId}`,
    currencyMode: "usd_only",
  });
  created.push(restaurantId);
  return { restaurantId };
}

const itemIn = (categoryId: string, name = "Sadza") => ({
  name,
  description: "With greens",
  priceUsd: "8.50",
  priceZig: null,
  categoryId,
});

/** The id of a category, found by name the way the editor's select would. */
const categoryIdOf = async (tenant: { restaurantId: string }, name: string) =>
  (await getMenu(tenant)).categories.find((category) => category.name === name)!.id;

beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});

beforeEach(() => revalidateTag.mockClear());

afterAll(async () => {
  await owner.db.delete(auditLog).where(inArray(auditLog.restaurantId, created));
  await owner.db.delete(menuItems).where(inArray(menuItems.restaurantId, created));
  await owner.db.delete(categories).where(inArray(categories.restaurantId, created));
  await owner.db.delete(restaurants).where(inArray(restaurants.id, created));
  await owner.pool.end();
  vi.unstubAllEnvs();
});

describe("a menu", () => {
  it("starts empty, under its restaurant's name and token", async () => {
    const tenant = await newRestaurant();
    expect(await getMenu(tenant)).toEqual({
      restaurantName: "Mama's Kitchen",
      menuToken: `menu-${tenant.restaurantId}`,
      currencyMode: "usd_only",
      // No rate yet, and the restaurant's default steps.
      pricing: { rate: null, zigStep: "10", usdStep: "0.01" },
      rateSetAt: null,
      categories: [],
    });
  });

  it("groups items under their category, each in the order it was added", async () => {
    const tenant = await newRestaurant();
    await addCategory(tenant, { name: "Starters" });
    await addCategory(tenant, { name: "Mains" });
    const mains = await categoryIdOf(tenant, "Mains");
    const starters = await categoryIdOf(tenant, "Starters");
    await addMenuItem(tenant, itemIn(mains, "Zebra steak"));
    await addMenuItem(tenant, itemIn(mains, "Beef stew"));
    await addMenuItem(tenant, itemIn(starters, "Soup"));

    const menu = await getMenu(tenant);

    expect(
      menu.categories.map(({ name, items }) => [name, items.map((item) => item.name)]),
    ).toEqual([
      ["Starters", ["Soup"]],
      ["Mains", ["Zebra steak", "Beef stew"]],
    ]);
    expect(menu.categories[1].items[0]).toMatchObject({
      description: "With greens",
      priceUsd: "8.50",
      priceZig: null,
    });
  });

  it("keeps a fixed ZiG price beside the USD one, and an item with only ZiG", async () => {
    const tenant = await newRestaurant();
    await addCategory(tenant, { name: "Mains" });
    const category = await categoryIdOf(tenant, "Mains");
    await addMenuItem(tenant, { ...itemIn(category, "Both"), priceZig: "200" });
    await addMenuItem(tenant, {
      ...itemIn(category, "ZiG only"),
      priceUsd: null,
      priceZig: "210",
    });

    expect((await getMenu(tenant)).categories[0].items).toMatchObject([
      { name: "Both", priceUsd: "8.50", priceZig: "200" },
      { name: "ZiG only", priceUsd: null, priceZig: "210" },
    ]);
  });

  it("keeps an empty category: the owner still has to fill it", async () => {
    const tenant = await newRestaurant();
    await addCategory(tenant, { name: "Desserts" });
    expect((await getMenu(tenant)).categories).toMatchObject([
      { name: "Desserts", items: [] },
    ]);
  });

  it("orders each restaurant's categories on their own", async () => {
    const [mine, theirs] = [await newRestaurant(), await newRestaurant()];
    await addCategory(theirs, { name: "Theirs" });
    await addCategory(theirs, { name: "Also theirs" });
    await addCategory(mine, { name: "Mine" });

    const [{ sortOrder }] = await owner.db
      .select({ sortOrder: categories.sortOrder })
      .from(categories)
      .where(eq(categories.restaurantId, mine.restaurantId));
    expect(sortOrder).toBe(0);
  });
});

describe("tenant scope", () => {
  it("shows a restaurant only its own menu", async () => {
    const [mine, theirs] = [await newRestaurant("Mine"), await newRestaurant("Theirs")];
    await addCategory(mine, { name: "My mains" });
    await addCategory(theirs, { name: "Their mains" });

    const menu = await getMenu(mine);

    expect(menu.restaurantName).toBe("Mine");
    expect(menu.categories.map((category) => category.name)).toEqual(["My mains"]);
  });

  it("won't put an item under another restaurant's category", async () => {
    const [mine, theirs] = [await newRestaurant(), await newRestaurant()];
    await addCategory(theirs, { name: "Theirs" });
    const category = await categoryIdOf(theirs, "Theirs");

    expect(await addMenuItem(mine, itemIn(category))).toBe("no_such_category");

    expect(
      await owner.db
        .select()
        .from(menuItems)
        .where(eq(menuItems.categoryId, category)),
    ).toEqual([]);
  });

  it.each(["not-a-uuid", "'; drop table menu_items; --"])(
    "treats the malformed category %j like an unknown one",
    async (categoryId) => {
      const tenant = await newRestaurant();
      expect(await addMenuItem(tenant, itemIn(categoryId))).toBe("no_such_category");
    },
  );
});

describe("an entered platform admin's writes", () => {
  const platformAdminId = crypto.randomUUID();

  const auditEntries = ({ restaurantId }: { restaurantId: string }) =>
    owner.db.select().from(auditLog).where(eq(auditLog.restaurantId, restaurantId));

  it("audits a new category, naming it and the admin", async () => {
    const tenant = await newRestaurant();

    await addCategory({ ...tenant, platformAdminId }, { name: "Mains" });

    expect(await auditEntries(tenant)).toMatchObject([
      {
        actorType: "platform_admin",
        actorId: platformAdminId,
        action: "category.create",
        entityType: "category",
        entityId: await categoryIdOf(tenant, "Mains"),
      },
    ]);
  });

  it("audits a new item, naming it and the admin", async () => {
    const tenant = await newRestaurant();
    await addCategory(tenant, { name: "Mains" });
    const category = await categoryIdOf(tenant, "Mains");

    await addMenuItem({ ...tenant, platformAdminId }, itemIn(category));

    const [item] = await owner.db
      .select({ id: menuItems.id })
      .from(menuItems)
      .where(eq(menuItems.categoryId, category));
    expect(await auditEntries(tenant)).toMatchObject([
      {
        actorType: "platform_admin",
        actorId: platformAdminId,
        action: "menu_item.create",
        entityType: "menu_item",
        entityId: item.id,
      },
    ]);
  });

  it("audits nothing when an item is refused", async () => {
    const tenant = await newRestaurant();

    await addMenuItem({ ...tenant, platformAdminId }, itemIn(crypto.randomUUID()));

    expect(await auditEntries(tenant)).toEqual([]);
  });

  it("adds nothing it can't audit", async () => {
    const tenant = await newRestaurant();
    const unauditable = { ...tenant, platformAdminId: "not-a-uuid" };

    await expect(addCategory(unauditable, { name: "Mains" })).rejects.toThrow();

    expect((await getMenu(tenant)).categories).toEqual([]);
  });

  it("leaves an owner's own edits out of the log, as spec 01's list does", async () => {
    const tenant = await newRestaurant();

    await addCategory(tenant, { name: "Mains" });
    await addMenuItem(tenant, itemIn(await categoryIdOf(tenant, "Mains")));

    expect(await auditEntries(tenant)).toEqual([]);
  });
});

describe("the public page's cache", () => {
  it("is revalidated for this restaurant alone when a category is added", async () => {
    const tenant = await newRestaurant();

    await addCategory(tenant, { name: "Mains" });

    expect(revalidateTag.mock.calls).toEqual([
      [menuTag(tenant.restaurantId), { expire: 0 }],
    ]);
  });

  it("is revalidated for this restaurant alone when an item is added", async () => {
    const tenant = await newRestaurant();
    await addCategory(tenant, { name: "Mains" });
    const category = await categoryIdOf(tenant, "Mains");
    revalidateTag.mockClear();

    await addMenuItem(tenant, itemIn(category));

    expect(revalidateTag.mock.calls).toEqual([
      [menuTag(tenant.restaurantId), { expire: 0 }],
    ]);
  });

  it("is left alone when a save is refused", async () => {
    const tenant = await newRestaurant();

    await addMenuItem(tenant, itemIn(crypto.randomUUID()));

    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("gets a different tag for each restaurant", () => {
    expect(menuTag("a")).not.toBe(menuTag("b"));
  });
});

describe("an item's availability", () => {
  const platformAdminId = crypto.randomUUID();

  const addSadza = async (tenant: { restaurantId: string }) => {
    await addCategory(tenant, { name: "Mains" });
    const categoryId = await categoryIdOf(tenant, "Mains");
    await addMenuItem(tenant, itemIn(categoryId));
    return (await getMenu(tenant)).categories[0].items[0].id;
  };

  const availableOf = async (tenant: { restaurantId: string }, itemId: string) =>
    (await getMenu(tenant)).categories[0].items.find((item) => item.id === itemId)?.available;

  it("starts available", async () => {
    const tenant = await newRestaurant();
    const itemId = await addSadza(tenant);
    expect(await availableOf(tenant, itemId)).toBe(true);
  });

  it("is marked sold out and back on, by the restaurant's own staff", async () => {
    const tenant = await newRestaurant();
    const itemId = await addSadza(tenant);

    expect(await setItemAvailability(tenant, itemId, false)).toBe("saved");
    expect(await availableOf(tenant, itemId)).toBe(false);

    expect(await setItemAvailability(tenant, itemId, true)).toBe("saved");
    expect(await availableOf(tenant, itemId)).toBe(true);
  });

  it("is refused for another restaurant's item, and that item is left alone", async () => {
    const [mine, theirs] = [await newRestaurant(), await newRestaurant()];
    const itemId = await addSadza(theirs);

    expect(await setItemAvailability(mine, itemId, false)).toBe("no_such_item");
    expect(await availableOf(theirs, itemId)).toBe(true);
  });

  it.each(["not-a-uuid", "'; drop table menu_items; --", ""])(
    "treats the malformed id %j like an unknown one",
    async (itemId) => {
      const tenant = await newRestaurant();
      expect(await setItemAvailability(tenant, itemId, false)).toBe("no_such_item");
    },
  );

  it("revalidates this restaurant's public page once it's saved", async () => {
    const tenant = await newRestaurant();
    const itemId = await addSadza(tenant);
    revalidateTag.mockClear();

    await setItemAvailability(tenant, itemId, false);

    expect(revalidateTag.mock.calls).toEqual([
      [menuTag(tenant.restaurantId), { expire: 0 }],
    ]);
  });

  it("is left alone, and the page not revalidated, when refused", async () => {
    const [mine, theirs] = [await newRestaurant(), await newRestaurant()];
    const itemId = await addSadza(theirs);
    revalidateTag.mockClear();

    await setItemAvailability(mine, itemId, false);

    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("is not audited for an owner or staff member, as spec 01's list leaves it out", async () => {
    const tenant = await newRestaurant();
    const itemId = await addSadza(tenant);

    await setItemAvailability(tenant, itemId, false);

    expect(
      await owner.db.select().from(auditLog).where(eq(auditLog.restaurantId, tenant.restaurantId)),
    ).toEqual([]);
  });

  it("is audited for an entered platform admin, naming the item and the admin", async () => {
    const tenant = await newRestaurant();
    const itemId = await addSadza(tenant);

    await setItemAvailability({ ...tenant, platformAdminId }, itemId, false);

    expect(
      await owner.db.select().from(auditLog).where(eq(auditLog.restaurantId, tenant.restaurantId)),
    ).toMatchObject([
      {
        actorType: "platform_admin",
        actorId: platformAdminId,
        action: "menu_item.availability",
        entityType: "menu_item",
        entityId: itemId,
        details: { available: false },
      },
    ]);
  });
});

/** A restaurant with the given categories, each holding the named items. */
async function menuOf(layout: Record<string, string[]>) {
  const tenant = await newRestaurant();
  for (const name of Object.keys(layout)) await addCategory(tenant, { name });
  for (const [name, items] of Object.entries(layout)) {
    const categoryId = await categoryIdOf(tenant, name);
    for (const item of items) await addMenuItem(tenant, itemIn(categoryId, item));
  }
  revalidateTag.mockClear();
  return tenant;
}

const shape = async (tenant: { restaurantId: string }) =>
  Object.fromEntries(
    (await getMenu(tenant)).categories.map(({ name, items }) => [
      name,
      items.map((item) => item.name),
    ]),
  );

const itemIdOf = async (tenant: { restaurantId: string }, name: string) =>
  (await getMenu(tenant)).categories
    .flatMap((category) => category.items)
    .find((item) => item.name === name)!.id;

const edit = (categoryId: string, change: Record<string, unknown> = {}) => ({
  name: "Beef stew",
  description: "Slow-cooked",
  priceUsd: "9.00" as string | null,
  priceZig: null as string | null,
  sortOrder: 0,
  categoryId,
  ...change,
});

const touchedCache = () => revalidateTag.mock.calls.length;

describe("renaming a category", () => {
  it("changes its name, keeps its place and its items", async () => {
    const tenant = await menuOf({ Starters: [], Mains: ["Stew"] });

    expect(
      await renameCategory(tenant, await categoryIdOf(tenant, "Mains"), {
        name: "Big plates",
      }),
    ).toBe("saved");

    expect(await shape(tenant)).toEqual({ Starters: [], "Big plates": ["Stew"] });
    expect(Object.keys(await shape(tenant))).toEqual(["Starters", "Big plates"]);
    expect(touchedCache()).toBe(1);
  });

  it("won't rename another restaurant's category, or an unknown one", async () => {
    const [mine, theirs] = [await menuOf({}), await menuOf({ Theirs: [] })];
    const theirCategory = await categoryIdOf(theirs, "Theirs");

    for (const id of [theirCategory, crypto.randomUUID(), "not-a-uuid"]) {
      expect(await renameCategory(mine, id, { name: "Mine now" })).toBe("not_found");
    }

    expect(await shape(theirs)).toEqual({ Theirs: [] });
    expect(touchedCache()).toBe(0);
  });
});

describe("reordering categories", () => {
  it("shows them in the order given", async () => {
    const tenant = await menuOf({ A: [], B: [], C: [] });
    const [a, b, c] = await Promise.all(
      ["A", "B", "C"].map((name) => categoryIdOf(tenant, name)),
    );

    expect(await reorderCategories(tenant, [c, a, b])).toBe("saved");

    expect(Object.keys(await shape(tenant))).toEqual(["C", "A", "B"]);
    expect(touchedCache()).toBe(1);
  });

  it("refuses a list with another restaurant's category in it, and changes nothing", async () => {
    const tenant = await menuOf({ A: [], B: [] });
    const theirs = await menuOf({ Theirs: [] });
    const [a, b] = await Promise.all(
      ["A", "B"].map((name) => categoryIdOf(tenant, name)),
    );
    const theirCategory = await categoryIdOf(theirs, "Theirs");

    expect(await reorderCategories(tenant, [b, theirCategory, a])).toBe("not_found");

    expect(Object.keys(await shape(tenant))).toEqual(["A", "B"]);
    const [row] = await owner.db
      .select({ sortOrder: categories.sortOrder })
      .from(categories)
      .where(eq(categories.id, theirCategory));
    expect(row.sortOrder).toBe(0);
    expect(touchedCache()).toBe(0);
  });

  it("refuses an archived or malformed id", async () => {
    const tenant = await menuOf({ A: [], B: [] });
    const a = await categoryIdOf(tenant, "A");
    await archiveCategory(tenant, a);

    expect(await reorderCategories(tenant, [a])).toBe("not_found");
    expect(await reorderCategories(tenant, ["not-a-uuid"])).toBe("not_found");
  });
});

describe("archiving a category", () => {
  it("takes an empty category off the menu, and keeps the row", async () => {
    const tenant = await menuOf({ Starters: [], Mains: [] });
    const starters = await categoryIdOf(tenant, "Starters");

    expect(await archiveCategory(tenant, starters)).toBe("archived");

    expect(await shape(tenant)).toEqual({ Mains: [] });
    const [row] = await owner.db.select().from(categories).where(eq(categories.id, starters));
    expect(row.archivedAt).toBeInstanceOf(Date);
    expect(touchedCache()).toBe(1);
  });

  it("refuses a category that still has items, and changes nothing", async () => {
    const tenant = await menuOf({ Mains: ["Stew"] });

    expect(await archiveCategory(tenant, await categoryIdOf(tenant, "Mains"))).toBe(
      "not_empty",
    );

    expect(await shape(tenant)).toEqual({ Mains: ["Stew"] });
    expect(touchedCache()).toBe(0);
  });

  it("moves its items to the category chosen, after what is already there", async () => {
    const tenant = await menuOf({ Old: ["Soup", "Stew"], New: ["Rice"] });

    expect(
      await archiveCategory(
        tenant,
        await categoryIdOf(tenant, "Old"),
        await categoryIdOf(tenant, "New"),
      ),
    ).toBe("archived");

    expect(await shape(tenant)).toEqual({ New: ["Rice", "Soup", "Stew"] });
  });

  it("doesn't count an archived item as one that needs moving", async () => {
    const tenant = await menuOf({ Mains: ["Stew"] });
    await archiveMenuItem(tenant, await itemIdOf(tenant, "Stew"));

    expect(await archiveCategory(tenant, await categoryIdOf(tenant, "Mains"))).toBe(
      "archived",
    );
  });

  it.each([
    ["itself", (own: string) => own],
    ["an unknown category", () => crypto.randomUUID()],
    ["a malformed id", () => "not-a-uuid"],
  ])("won't move items to %s", async (_name, target) => {
    const tenant = await menuOf({ Mains: ["Stew"] });
    const mains = await categoryIdOf(tenant, "Mains");

    expect(await archiveCategory(tenant, mains, target(mains))).toBe("not_found");

    expect(await shape(tenant)).toEqual({ Mains: ["Stew"] });
  });

  it("won't move items to another restaurant's category, or an archived one", async () => {
    const tenant = await menuOf({ Mains: ["Stew"], Gone: [] });
    const theirs = await menuOf({ Theirs: [] });
    const mains = await categoryIdOf(tenant, "Mains");
    const gone = await categoryIdOf(tenant, "Gone");
    await archiveCategory(tenant, gone);

    for (const target of [await categoryIdOf(theirs, "Theirs"), gone]) {
      expect(await archiveCategory(tenant, mains, target)).toBe("not_found");
    }

    expect(await shape(tenant)).toEqual({ Mains: ["Stew"] });
    expect(await shape(theirs)).toEqual({ Theirs: [] });
  });

  it("won't archive another restaurant's category, or one already archived", async () => {
    const [mine, theirs] = [await menuOf({ Mine: [] }), await menuOf({ Theirs: [] })];
    const mineId = await categoryIdOf(mine, "Mine");

    expect(await archiveCategory(mine, await categoryIdOf(theirs, "Theirs"))).toBe(
      "not_found",
    );
    await archiveCategory(mine, mineId);
    expect(await archiveCategory(mine, mineId)).toBe("not_found");
    expect(await shape(theirs)).toEqual({ Theirs: [] });
  });

  it("can't be added to once archived", async () => {
    const tenant = await menuOf({ Gone: [] });
    const gone = await categoryIdOf(tenant, "Gone");
    await archiveCategory(tenant, gone);

    expect(await addMenuItem(tenant, itemIn(gone))).toBe("no_such_category");
  });

  it("leaves no live item behind when an item is added as it archives", async () => {
    const tenant = await menuOf({ Mains: [] });
    const mains = await categoryIdOf(tenant, "Mains");

    const [archived, added] = await Promise.all([
      archiveCategory(tenant, mains),
      addMenuItem(tenant, itemIn(mains, "Latecomer")),
    ]);

    // Either the item got in first and the archive was refused, or it was
    // archived first and the item was refused. Never both succeeding.
    expect(
      (archived === "archived" && added === "no_such_category") ||
        (archived === "not_empty" && added === "saved"),
    ).toBe(true);
  });
});

describe("editing an item", () => {
  it("saves its name, description, price, category and sort order", async () => {
    const tenant = await menuOf({ Mains: ["Stew"], Sides: ["Rice"] });
    const sides = await categoryIdOf(tenant, "Sides");

    expect(
      await updateMenuItem(
        tenant,
        await itemIdOf(tenant, "Stew"),
        edit(sides, { name: "Beef stew", priceUsd: "9.00", sortOrder: 5 }),
      ),
    ).toBe("saved");

    const menu = await getMenu(tenant);
    expect(menu.categories.map((category) => category.items.length)).toEqual([0, 2]);
    expect(menu.categories[1].items.find((item) => item.name === "Beef stew")).toMatchObject({
      description: "Slow-cooked",
      priceUsd: "9.00",
      sortOrder: 5,
    });
    expect(touchedCache()).toBe(1);
  });

  it("orders items by their sort order", async () => {
    const tenant = await menuOf({ Mains: ["First", "Second"] });
    const mains = await categoryIdOf(tenant, "Mains");

    await updateMenuItem(tenant, await itemIdOf(tenant, "First"), edit(mains, { name: "First", sortOrder: 9 }));

    expect((await shape(tenant)).Mains).toEqual(["Second", "First"]);
  });

  it("sets a fixed ZiG price, keeps it when it's sent back, and clears it when blank", async () => {
    const tenant = await menuOf({ Mains: ["Stew"] });
    const id = await itemIdOf(tenant, "Stew");
    const mains = await categoryIdOf(tenant, "Mains");
    const zig = async () =>
      (await owner.db.select().from(menuItems).where(eq(menuItems.id, id)))[0].priceZig;

    await updateMenuItem(tenant, id, edit(mains, { priceZig: "210" }));
    expect(await zig()).toBe("210");

    await updateMenuItem(tenant, id, edit(mains, { name: "Goat stew", priceZig: "210" }));
    expect(await zig()).toBe("210");

    await updateMenuItem(tenant, id, edit(mains));
    expect(await zig()).toBeNull();
  });

  it("takes the USD price off an item that has a ZiG price, but not one that has no other", async () => {
    const tenant = await menuOf({ Mains: ["Stew", "Soup"] });
    const mains = await categoryIdOf(tenant, "Mains");
    const [stew, soup] = [await itemIdOf(tenant, "Stew"), await itemIdOf(tenant, "Soup")];

    expect(
      await updateMenuItem(tenant, stew, edit(mains, { priceUsd: null, priceZig: "210" })),
    ).toBe("saved");
    expect(await updateMenuItem(tenant, soup, edit(mains, { name: "Soup", priceUsd: null }))).toBe(
      "no_price",
    );

    const [row] = await owner.db.select().from(menuItems).where(eq(menuItems.id, soup));
    expect(row.priceUsd).toBe("8.50");
  });

  it("won't move an item to another restaurant's category, or an archived one", async () => {
    const tenant = await menuOf({ Mains: ["Stew"], Gone: [] });
    const theirs = await menuOf({ Theirs: [] });
    const gone = await categoryIdOf(tenant, "Gone");
    await archiveCategory(tenant, gone);
    const stew = await itemIdOf(tenant, "Stew");
    revalidateTag.mockClear();

    for (const target of [await categoryIdOf(theirs, "Theirs"), gone, "not-a-uuid"]) {
      expect(await updateMenuItem(tenant, stew, edit(target))).toBe("no_such_category");
    }

    expect(await shape(tenant)).toEqual({ Mains: ["Stew"] });
    expect(touchedCache()).toBe(0);
  });

  it("won't edit another restaurant's item, an unknown one or an archived one", async () => {
    const [mine, theirs] = [await menuOf({ Mine: ["Soup"] }), await menuOf({ Theirs: ["Stew"] })];
    const mineCategory = await categoryIdOf(mine, "Mine");
    const archived = await itemIdOf(mine, "Soup");
    await archiveMenuItem(mine, archived);

    for (const id of [
      await itemIdOf(theirs, "Stew"),
      crypto.randomUUID(),
      "not-a-uuid",
      archived,
    ]) {
      expect(await updateMenuItem(mine, id, edit(mineCategory, { name: "Hijacked" }))).toBe(
        "not_found",
      );
    }

    expect(await shape(theirs)).toEqual({ Theirs: ["Stew"] });
  });
});

describe("archiving an item", () => {
  it("takes it off the menu and keeps the row", async () => {
    const tenant = await menuOf({ Mains: ["Stew", "Soup"] });
    const id = await itemIdOf(tenant, "Stew");

    expect(await archiveMenuItem(tenant, id)).toBe("archived");

    expect(await shape(tenant)).toEqual({ Mains: ["Soup"] });
    const [row] = await owner.db.select().from(menuItems).where(eq(menuItems.id, id));
    expect(row.archivedAt).toBeInstanceOf(Date);
    expect(touchedCache()).toBe(1);
  });

  it("won't archive another restaurant's item, an unknown one or one already archived", async () => {
    const [mine, theirs] = [await menuOf({ Mine: ["Soup"] }), await menuOf({ Theirs: ["Stew"] })];
    const soup = await itemIdOf(mine, "Soup");
    await archiveMenuItem(mine, soup);
    revalidateTag.mockClear();

    for (const id of [await itemIdOf(theirs, "Stew"), crypto.randomUUID(), "not-a-uuid", soup]) {
      expect(await archiveMenuItem(mine, id)).toBe("not_found");
    }

    expect(await shape(theirs)).toEqual({ Theirs: ["Stew"] });
    expect(touchedCache()).toBe(0);
  });
});

describe("an entered platform admin's edits", () => {
  const platformAdminId = crypto.randomUUID();

  it("audits each kind of change under its own action, and revalidates after each", async () => {
    const tenant = await menuOf({ A: ["Stew"], B: [], C: [] });
    const admin = { ...tenant, platformAdminId };
    const [a, b, c] = await Promise.all(
      ["A", "B", "C"].map((name) => categoryIdOf(tenant, name)),
    );
    const stew = await itemIdOf(tenant, "Stew");

    await addCategory(admin, { name: "D" });
    await addMenuItem(admin, itemIn(a, "Soup"));
    await setItemAvailability(admin, stew, false);
    await renameCategory(admin, b, { name: "B2" });
    await reorderCategories(admin, [c, b, a]);
    await updateMenuItem(admin, stew, edit(a));
    await archiveCategory(admin, b);
    await archiveMenuItem(admin, stew);

    const entries = await owner.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.restaurantId, tenant.restaurantId));
    expect(entries.map((entry) => entry.action).sort()).toEqual([
      "category.archive",
      "category.create",
      "category.rename",
      "category.reorder",
      "menu_item.archive",
      "menu_item.availability",
      "menu_item.create",
      "menu_item.update",
    ]);
    expect(entries.every((entry) => entry.actorId === platformAdminId)).toBe(true);
    expect(touchedCache()).toBe(entries.length);
  });
});
