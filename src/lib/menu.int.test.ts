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
import { addCategory, addMenuItem, getMenu } from "./menu";
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
