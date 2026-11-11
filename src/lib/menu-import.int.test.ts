import { asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog, categories, menuItems, restaurants } from "@/db/schema";
import { openOwnerDatabase, testDatabaseSettings } from "../../test/integration/database";
import { addCategory, addMenuItem, archiveCategory, getMenu } from "./menu";
import { menuTag } from "./menu-cache";
import { importMenu, previewMenuImport } from "./menu-import";

const revalidateTag = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidateTag }));

/** An item of this name fails to insert, after the rows before it went in. */
const failing = vi.hoisted(() => ({ name: "" }));
vi.mock("./menu", async (importOriginal) => {
  const menu = await importOriginal<typeof import("./menu")>();
  return {
    ...menu,
    insertMenuItem: (...args: Parameters<typeof menu.insertMenuItem>) => {
      if (failing.name && args[2].name === failing.name) throw new Error("boom");
      return menu.insertMenuItem(...args);
    },
  };
});

/** Runs as app_tenant, so everything here also holds under RLS. */
const owner = openOwnerDatabase();
const created: string[] = [];

async function newRestaurant(currencyMode: "usd_only" | "both" | "zig_only" = "both") {
  const restaurantId = crypto.randomUUID();
  await owner.db.insert(restaurants).values({
    id: restaurantId,
    name: "Import Kitchen",
    slug: `menu-import-${restaurantId}`,
    menuToken: `menu-import-${restaurantId}`,
    currencyMode,
  });
  created.push(restaurantId);
  return { restaurantId, staffId: crypto.randomUUID(), role: "owner" as const };
}

const header = "category,name,description,price_usd,price_zig,available";

const itemsOf = (restaurantId: string) =>
  owner.db
    .select({
      name: menuItems.name,
      category: categories.name,
      description: menuItems.description,
      priceUsd: menuItems.priceUsd,
      priceZig: menuItems.priceZig,
      available: menuItems.available,
      sortOrder: menuItems.sortOrder,
    })
    .from(menuItems)
    .innerJoin(categories, eq(categories.id, menuItems.categoryId))
    .where(eq(menuItems.restaurantId, restaurantId))
    .orderBy(asc(categories.sortOrder), asc(menuItems.sortOrder));

const auditOf = (restaurantId: string) =>
  owner.db.select().from(auditLog).where(eq(auditLog.restaurantId, restaurantId));

const report = <T,>(result: T) => {
  if (result && typeof result === "object" && "error" in result) {
    throw new Error(String((result as { error: string }).error));
  }
  return result as Exclude<T, { error: string }>;
};

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

describe("previewMenuImport", () => {
  it("reports every row and writes nothing", async () => {
    const tenant = await newRestaurant();
    const csv = `${header}\nMains,Sadza,With greens,8.50,,yes\nDrinks,Mazoe,,1.50,,no\n`;

    const preview = report(await previewMenuImport(tenant, csv));

    expect(preview).toMatchObject({
      columns: ["category", "name", "description", "price_usd", "price_zig", "available"],
      ready: 2,
      imported: null,
      rows: [
        { line: 2, values: ["Mains", "Sadza", "With greens", "8.50", "", "yes"], problems: [] },
        { line: 3, values: ["Drinks", "Mazoe", "", "1.50", "", "no"], problems: [] },
      ],
    });
    expect(await itemsOf(tenant.restaurantId)).toEqual([]);
    expect((await getMenu(tenant)).categories).toEqual([]);
    expect(await auditOf(tenant.restaurantId)).toEqual([]);
  });

  it("gives each bad row its problems, with the single form's rules", async () => {
    const tenant = await newRestaurant();
    const long = "x".repeat(201);
    const csv = [
      header,
      "Mains,Sadza,,8.505,,yes", // three decimals
      "Mains,No price,,,,", // neither price
      `Mains,${long},,5,,`, // name too long
      ",Orphan,,5,,", // no category
      "Mains,Tea,,1e3,,", // Postgres would take this as numeric; the form doesn't
      "Mains,Maybe,,5,,perhaps", // available isn't yes or no
      "Mains,Extra,,5,,yes,surplus",
    ].join("\n");

    const preview = report(await previewMenuImport(tenant, csv));

    expect(preview.ready).toBe(0);
    expect(preview.rows.map((row) => row.problems)).toEqual([
      ["Enter the USD price as a number, like 8.50."],
      ["Enter a USD price, a ZiG price, or both."],
      ["Enter the item's name, up to 200 characters."],
      ["Enter the category's name, up to 200 characters."],
      ["Enter the USD price as a number, like 8.50."],
      ['Write yes or no in "available", or leave it blank for yes.'],
      ["This row has more values than the header has columns."],
    ]);
  });

  it("skips an item already in that category, whatever its case, and a repeat in the file", async () => {
    const tenant = await newRestaurant();
    await addCategory(tenant, { name: "Mains" });
    const [{ id: mains }] = (await getMenu(tenant)).categories;
    await addMenuItem(tenant, { name: "Sadza", description: "", priceUsd: "8", priceZig: null, categoryId: mains });

    const csv = `${header}\nmains,SADZA,,8,,\nDrinks,Tea,,1,,\nDrinks,tea,,1,,\nDesserts,Sadza,,3,,`;
    const preview = report(await previewMenuImport(tenant, csv));

    expect(preview.rows.map((row) => row.problems)).toEqual([
      ['"SADZA" is already on the menu in Mains.'],
      [],
      ['"tea" is already in this file, on line 3.'],
      [],
    ]);
  });

  it("notes a price the restaurant's currency setting doesn't show, and still takes the row", async () => {
    const usdOnly = await newRestaurant("usd_only");
    const zigOnly = await newRestaurant("zig_only");
    const csv = `${header}\nMains,Sadza,,8,210,`;

    const [usd] = report(await previewMenuImport(usdOnly, csv)).rows;
    const [zig] = report(await previewMenuImport(zigOnly, csv)).rows;

    expect(usd).toMatchObject({
      problems: [],
      notes: ["This restaurant shows prices in USD only, so the ZiG price is saved but not shown."],
    });
    expect(zig.notes).toEqual([
      "This restaurant shows prices in ZiG only, so the USD price is saved but not shown.",
    ]);
  });

  it("refuses a file it can't read as a whole", async () => {
    const tenant = await newRestaurant();
    expect(await previewMenuImport(tenant, "category,name,colour\nMains,Sadza,red")).toEqual({
      error: expect.stringContaining('"colour"'),
    });
  });
});

describe("importMenu", () => {
  it("adds every valid row in one go, new categories in file order, items at the end of theirs", async () => {
    const tenant = await newRestaurant();
    await addCategory(tenant, { name: "Starters" });
    const [{ id: starters }] = (await getMenu(tenant)).categories;
    await addMenuItem(tenant, { name: "Soup", description: "", priceUsd: "3", priceZig: null, categoryId: starters });

    const csv = [
      header,
      "Mains,Sadza,With greens,8.50,,yes",
      "Drinks,Mazoe,,1.50,,no",
      "Mains,Bream,,,320,",
      "starters,Samosa,,2,,",
      "Mains,Bad,,x,,",
    ].join("\r\n");

    const result = report(await importMenu(tenant, csv));

    expect(result).toMatchObject({ ready: 4, imported: 4 });
    expect(result.rows.at(-1)!.problems).not.toEqual([]);
    expect(await itemsOf(tenant.restaurantId)).toEqual([
      { name: "Soup", category: "Starters", description: "", priceUsd: "3", priceZig: null, available: true, sortOrder: 0 },
      { name: "Samosa", category: "Starters", description: "", priceUsd: "2", priceZig: null, available: true, sortOrder: 1 },
      { name: "Sadza", category: "Mains", description: "With greens", priceUsd: "8.50", priceZig: null, available: true, sortOrder: 0 },
      { name: "Bream", category: "Mains", description: "", priceUsd: null, priceZig: "320", available: true, sortOrder: 1 },
      { name: "Mazoe", category: "Drinks", description: "", priceUsd: "1.50", priceZig: null, available: false, sortOrder: 0 },
    ]);
    expect((await getMenu(tenant)).categories.map((category) => category.name)).toEqual([
      "Starters",
      "Mains",
      "Drinks",
    ]);
    expect(revalidateTag).toHaveBeenCalledWith(menuTag(tenant.restaurantId), expect.anything());
  });

  it("is audited once, with the counts, and as the platform admin when one imports", async () => {
    const tenant = await newRestaurant();
    const csv = `${header}\nMains,Sadza,,8,,\nMains,Rice,,2,,\nMains,,,2,,`;

    await importMenu(tenant, csv);

    expect(await auditOf(tenant.restaurantId)).toEqual([
      expect.objectContaining({
        action: "menu.import",
        entityType: "restaurant",
        entityId: tenant.restaurantId,
        actorType: "staff",
        actorId: tenant.staffId,
        details: { items: 2, categories: 1, skipped: 1 },
      }),
    ]);
  });

  it("writes no audit entry and nothing else when no row is valid", async () => {
    const tenant = await newRestaurant();

    const result = report(await importMenu(tenant, `${header}\nMains,,,8,,`));

    expect(result.imported).toBe(0);
    expect(await auditOf(tenant.restaurantId)).toEqual([]);
    expect((await getMenu(tenant)).categories).toEqual([]);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("records an entered platform admin by platform_admins.id, once", async () => {
    const tenant = { ...(await newRestaurant()), platformAdminId: crypto.randomUUID() };

    await importMenu(tenant, `${header}\nMains,Sadza,,8,,\nMains,Rice,,2,,`);

    const entries = await auditOf(tenant.restaurantId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actorType: "platform_admin", actorId: tenant.platformAdminId });
  });

  it("puts nothing in an archived category: a new one of that name is made", async () => {
    const tenant = await newRestaurant();
    await addCategory(tenant, { name: "Old" });
    const [{ id: old }] = (await getMenu(tenant)).categories;
    await archiveCategory(tenant, old);

    report(await importMenu(tenant, `${header}\nOld,Sadza,,8,,`));

    const live = (await getMenu(tenant)).categories;
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ name: "Old", items: [expect.objectContaining({ name: "Sadza" })] });
    expect(live[0].id).not.toBe(old);
  });

  it("adds nothing when one insert fails: one transaction", async () => {
    const tenant = await newRestaurant();
    failing.name = "Boom";

    await expect(
      importMenu(tenant, `${header}\nMains,Sadza,,8,,\nDrinks,Boom,,1,,`),
    ).rejects.toThrow("boom");

    failing.name = "";
    expect(await itemsOf(tenant.restaurantId)).toEqual([]);
    expect((await getMenu(tenant)).categories).toEqual([]);
    expect(await auditOf(tenant.restaurantId)).toEqual([]);
  });

  it("only ever writes to the context's restaurant", async () => {
    const mine = await newRestaurant();
    const theirs = await newRestaurant();

    await importMenu(mine, `${header}\nMains,Sadza,,8,,`);

    expect(await itemsOf(theirs.restaurantId)).toEqual([]);
    expect(await itemsOf(mine.restaurantId)).toHaveLength(1);
  });
});
