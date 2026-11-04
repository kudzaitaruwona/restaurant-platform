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
import { categories, menuItems, restaurants } from "@/db/schema";
import { BUILD_SAMPLE_TOKEN } from "@/lib/public-menu";
import { menuTag } from "@/lib/menu-cache";
import {
  openOwnerDatabase,
  testDatabaseSettings,
} from "../../../../test/integration/database";
import { GET, generateStaticParams } from "./route";

const cache = vi.hoisted(() => ({
  cacheTag: vi.fn(),
  cacheLife: vi.fn(),
  revalidateTag: vi.fn(),
}));
vi.mock("next/cache", () => cache);

/**
 * The public menu page, against a real Postgres as app_tenant. That role sees no
 * tenant rows at all until a tenant is set, so a page with items on it is itself
 * proof the query ran under RLS.
 *
 * `use cache` is inert here, and the proxy doesn't run: what's checked is what
 * it would store and how it's tagged. test/production/public-pages.test.ts runs
 * the real cache, on a production build.
 */
const owner = openOwnerDatabase();
const created: string[] = [];

async function newRestaurant(name: string) {
  const id = crypto.randomUUID();
  await owner.db.insert(restaurants).values({
    id,
    name,
    slug: `public-menu-${id}`,
    menuToken: `token-${id}`,
    currencyMode: "usd_only",
    wifiPassword: "kept-off-the-page",
  });
  created.push(id);
  return { id, menuToken: `token-${id}` };
}

async function addCategory(restaurantId: string, name: string, sortOrder = 0) {
  const id = crypto.randomUUID();
  await owner.db
    .insert(categories)
    .values({ id, restaurantId, name, sortOrder });
  return id;
}

const addItem = (
  restaurantId: string,
  categoryId: string,
  item: { name: string; description?: string; priceUsd?: string; priceZig?: string; sortOrder?: number; archivedAt?: Date },
) => owner.db.insert(menuItems).values({ restaurantId, categoryId, ...item });

const visit = (menuToken: string) =>
  GET(new Request(`http://localhost:3000/m/${menuToken}`), {
    params: Promise.resolve({ menuToken }),
  });

const page = async (menuToken: string) => (await visit(menuToken)).text();

beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});

beforeEach(() => {
  cache.cacheTag.mockClear();
  cache.cacheLife.mockClear();
});

afterAll(async () => {
  await owner.db.delete(menuItems).where(inArray(menuItems.restaurantId, created));
  await owner.db.delete(categories).where(inArray(categories.restaurantId, created));
  await owner.db.delete(restaurants).where(inArray(restaurants.id, created));
  await owner.pool.end();
  vi.unstubAllEnvs();
});

describe("/m/{menu_token}", () => {
  it("leaves out archived items and archived categories", async () => {
    const { id, menuToken } = await newRestaurant("Archiving");
    const mains = await addCategory(id, "Mains", 0);
    const gone = await addCategory(id, "Retired specials", 1);
    await addItem(id, mains, { name: "Beef stew", priceUsd: "8" });
    await addItem(id, mains, { name: "Old pie", priceUsd: "5", archivedAt: new Date() });
    await addItem(id, gone, { name: "Hidden stew", priceUsd: "9", archivedAt: new Date() });
    await owner.db
      .update(categories)
      .set({ archivedAt: new Date() })
      .where(eq(categories.id, gone));

    const body = await page(menuToken);

    expect(body).toContain("Beef stew");
    expect(body).not.toContain("Old pie");
    expect(body).not.toContain("Retired specials");
    expect(body).not.toContain("Hidden stew");
  });

  it("is a whole HTML page", async () => {
    const { menuToken } = await newRestaurant("Mama's Kitchen");

    const response = await visit(menuToken);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const body = await response.text();
    expect(body).toMatch(/^<!doctype html>/i);
    expect(body).toContain("<h1>Mama&#39;s Kitchen</h1>");
    expect(body).toContain('name="viewport"');
  });

  it("shows items under their category, in the menu's order", async () => {
    const { id, menuToken } = await newRestaurant("Grouped");
    const mains = await addCategory(id, "Mains", 1);
    const starters = await addCategory(id, "Starters", 0);
    await addItem(id, mains, { name: "Beef stew", description: "With sadza", priceUsd: "8.5", sortOrder: 1 });
    await addItem(id, mains, { name: "Zebra steak", priceUsd: "21", sortOrder: 0 });
    await addItem(id, starters, { name: "Soup", priceUsd: "3" });

    const body = await page(menuToken);

    const order = ["Starters", "Soup", "$3.00", "Mains", "Zebra steak", "$21.00", "Beef stew", "$8.50", "With sadza"];
    const positions = order.map((text) => body.indexOf(text));
    expect(positions).not.toContain(-1);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("works with no JavaScript, because it has none", async () => {
    const { id, menuToken } = await newRestaurant("No scripts");
    await addItem(id, await addCategory(id, "Mains"), { name: "Stew", priceUsd: "8" });

    const body = await page(menuToken);

    expect(body).not.toMatch(/<script|\son\w+=|javascript:/i);
  });

  it("stays well inside the budget on a 30-item menu", async () => {
    const { id, menuToken } = await newRestaurant("Thirty items");
    for (const group of ["Starters", "Mains", "Drinks"]) {
      const categoryId = await addCategory(id, group);
      for (let n = 0; n < 10; n += 1) {
        await addItem(id, categoryId, {
          name: `${group} item ${n}`,
          description: "A sentence or two about what's in this and how it comes.",
          priceUsd: "12.50",
        });
      }
    }

    const body = await page(menuToken);

    expect(new TextEncoder().encode(body).length).toBeLessThan(100_000);
  });

  it("leaves out a category with nothing in it", async () => {
    const { id, menuToken } = await newRestaurant("Empty category");
    await addItem(id, await addCategory(id, "Mains"), { name: "Stew", priceUsd: "8" });
    await addCategory(id, "Coming soon");

    const body = await page(menuToken);

    expect(body).toContain("Mains");
    expect(body).not.toContain("Coming soon");
  });

  it("says so when there's nothing on the menu yet", async () => {
    const { menuToken } = await newRestaurant("Empty");
    expect(await page(menuToken)).toContain("isn't up yet");
  });

  it("shows a fixed ZiG price for an item with no USD price", async () => {
    const { id, menuToken } = await newRestaurant("ZiG only");
    await addItem(id, await addCategory(id, "Mains"), { name: "Stew", priceZig: "210" });

    expect(await page(menuToken)).toContain("ZiG 210");
  });

  it("escapes what an owner typed", async () => {
    const { id, menuToken } = await newRestaurant("<b>Bold</b>");
    const categoryId = await addCategory(id, "<i>Mains</i>");
    await addItem(id, categoryId, {
      name: "</li><script>alert(1)</script>",
      description: '"><img src=x onerror=alert(1)>',
      priceUsd: "8",
    });

    const body = await page(menuToken);

    expect(body).not.toContain("<script");
    expect(body).not.toContain("<img");
    expect(body).not.toContain("<b>Bold");
    expect(body).toContain("&lt;b&gt;Bold&lt;/b&gt;");
  });

  it("doesn't show the Wi-Fi password yet, or any ids", async () => {
    const { id, menuToken } = await newRestaurant("Private");
    const categoryId = await addCategory(id, "Mains");
    await addItem(id, categoryId, { name: "Stew", priceUsd: "8" });

    const body = await page(menuToken);

    expect(body).not.toContain("kept-off-the-page");
    expect(body).not.toContain(id);
    expect(body).not.toContain(categoryId);
  });
});

describe("tenants", () => {
  it("a token shows its own restaurant's menu and nobody else's", async () => {
    const [mine, theirs] = [await newRestaurant("Mine"), await newRestaurant("Theirs")];
    await addItem(mine.id, await addCategory(mine.id, "My mains"), { name: "My stew", priceUsd: "8" });
    await addItem(theirs.id, await addCategory(theirs.id, "Their mains"), { name: "Their stew", priceUsd: "9" });

    const body = await page(mine.menuToken);

    expect(body).toContain("My stew");
    expect(body).not.toContain("Their");
  });

  it.each(["no-such-token", "%", "' or 1=1 --"])(
    "the unknown token %j is a real 404, with nothing of anyone's on it",
    async (token) => {
      const response = await visit(token);

      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    },
  );
});

describe("caching", () => {
  it("a page is tagged for its restaurant alone, so a save refreshes only that one", async () => {
    const { id, menuToken } = await newRestaurant("Tagged");

    await visit(menuToken);

    expect(cache.cacheTag.mock.calls).toEqual([[menuTag(id)]]);
  });

  it("keeps a page for five minutes at most, with or without a save", async () => {
    const { menuToken } = await newRestaurant("Kept");

    await visit(menuToken);

    expect(cache.cacheLife.mock.calls).toEqual([[{ revalidate: 300, expire: 300 }]]);
  });

  it("forgets an unknown token soon: it has no restaurant to be revalidated by", async () => {
    await visit("no-such-token");

    expect(cache.cacheTag).not.toHaveBeenCalled();
    expect(cache.cacheLife.mock.calls).toEqual([["minutes"]]);
  });
});

describe("the build", () => {
  it("offers one sample token, because Cache Components won't take none", async () => {
    expect(await generateStaticParams()).toEqual([{ menuToken: BUILD_SAMPLE_TOKEN }]);
  });

  it("answers the sample without a restaurant: the build has no database", async () => {
    expect((await visit(BUILD_SAMPLE_TOKEN)).status).toBe(404);
  });
});
