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
import { categories, exchangeRates, menuItems, restaurants, specials, staff } from "@/db/schema";
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

// Photo addresses come from the storage interface; nothing here reaches R2.
vi.mock("@/lib/storage", () => ({
  getUrl: (key: string) => `https://cdn.example.test/${key}`,
}));

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

async function newRestaurant(
  name: string,
  currencyMode: "usd_only" | "zig_only" | "usd_primary" | "zig_primary" | "both" = "usd_only",
) {
  const id = crypto.randomUUID();
  await owner.db.insert(restaurants).values({
    id,
    name,
    slug: `public-menu-${id}`,
    menuToken: `token-${id}`,
    currencyMode,
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

/** Sets the rate the way the editor would: a new row, read as the latest. */
async function setRate(restaurantId: string, usdToZig: string) {
  const [{ id: setBy }] = await owner.db
    .insert(staff)
    .values({
      restaurantId,
      email: `${crypto.randomUUID()}@example.test`,
      displayName: "Rate setter",
    })
    .returning({ id: staff.id });
  await owner.db.insert(exchangeRates).values({ restaurantId, setBy, usdToZig });
}

const addItem = (
  restaurantId: string,
  categoryId: string,
  item: { name: string; description?: string; priceUsd?: string; priceZig?: string; photoKey?: string; sortOrder?: number; available?: boolean; archivedAt?: Date },
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
  await owner.db.delete(specials).where(inArray(specials.restaurantId, created));
  await owner.db.delete(exchangeRates).where(inArray(exchangeRates.restaurantId, created));
  await owner.db.delete(staff).where(inArray(staff.restaurantId, created));
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

  it("shows a lazy thumbnail with fixed dimensions, so the layout doesn't jump", async () => {
    const { id, menuToken } = await newRestaurant("Photos");
    await addItem(id, await addCategory(id, "Mains"), {
      name: "Stew",
      priceUsd: "8",
      photoKey: "menu/abc",
    });

    const body = await page(menuToken);

    const img = /<img [^>]*>/.exec(body)?.[0] ?? "";
    expect(img).toContain('src="https://cdn.example.test/menu/abc-320.webp"');
    expect(img).toContain('width="64"');
    expect(img).toContain('height="64"');
    expect(img).toContain('loading="lazy"');
    expect(img).toContain('decoding="async"');
    // Decorative: the item's name is right beside it.
    expect(img).toContain('alt=""');
  });

  it("draws no image for an item without a photo, and no empty box either", async () => {
    const { id, menuToken } = await newRestaurant("No photos");
    await addItem(id, await addCategory(id, "Mains"), { name: "Stew", priceUsd: "8" });

    expect(await page(menuToken)).not.toContain("<img");
  });

  it("stays inside the budget on 30 items with photos, which cost markup but no bytes of image", async () => {
    const { id, menuToken } = await newRestaurant("Thirty photos");
    const categoryId = await addCategory(id, "Mains");
    for (let n = 0; n < 30; n += 1) {
      await addItem(id, categoryId, {
        name: `Item ${n}`,
        description: "A sentence or two about what's in this and how it comes.",
        priceUsd: "12.50",
        photoKey: `menu/${crypto.randomUUID()}`,
      });
    }

    const body = await page(menuToken);

    expect(body.match(/<img /g)).toHaveLength(30);
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

describe("prices by currency_mode", () => {
  /** A $8 item on a menu at 26.2 ZiG to the dollar, in the given mode. */
  async function menuIn(
    mode: "usd_only" | "zig_only" | "usd_primary" | "zig_primary" | "both",
    item: { priceUsd?: string; priceZig?: string } = { priceUsd: "8" },
  ) {
    const { id, menuToken } = await newRestaurant(`Mode ${mode}`, mode);
    await setRate(id, "26.2");
    await addItem(id, await addCategory(id, "Mains"), { name: "Stew", ...item });
    return { id, menuToken };
  }

  const priceOf = (body: string) =>
    /<li[^>]*>\n<div class="text">\n<div class="item"><span>Stew<\/span>(.*?)<\/div>/.exec(body)![1];

  it("usd_only shows dollars alone", async () => {
    const { menuToken } = await menuIn("usd_only");
    expect(priceOf(await page(menuToken))).toBe('<span class="price">$8.00</span>');
  });

  it("zig_only shows ZiG alone, calculated and rounded up", async () => {
    const { menuToken } = await menuIn("zig_only");
    expect(priceOf(await page(menuToken))).toBe('<span class="price">ZiG 210</span>');
  });

  it("both shows $8.00 · ZiG 210", async () => {
    const { menuToken } = await menuIn("both");
    expect(priceOf(await page(menuToken))).toBe(
      '<span class="price">$8.00 · ZiG 210</span>',
    );
  });

  it("usd_primary shows $8.00 with ZiG 210 smaller underneath", async () => {
    const { menuToken } = await menuIn("usd_primary");
    expect(priceOf(await page(menuToken))).toBe(
      '<span class="price">$8.00<span class="sub">ZiG 210</span></span>',
    );
  });

  it("zig_primary shows ZiG 210 with $8.00 underneath", async () => {
    const { menuToken } = await menuIn("zig_primary");
    expect(priceOf(await page(menuToken))).toBe(
      '<span class="price">ZiG 210<span class="sub">$8.00</span></span>',
    );
  });

  it("shows a fixed ZiG price as set, whatever the rate", async () => {
    const { menuToken } = await menuIn("both", { priceUsd: "8", priceZig: "200" });
    expect(priceOf(await page(menuToken))).toContain("$8.00 · ZiG 200");
  });

  it("calculates the dollar price of a ZiG-only item, rounded up to the cent", async () => {
    const { menuToken } = await menuIn("both", { priceZig: "210" });
    expect(priceOf(await page(menuToken))).toContain("$8.02 · ZiG 210");
  });

  it("never shows a calculated ZiG price unrounded", async () => {
    const { id, menuToken } = await newRestaurant("Unrounded", "zig_only");
    await setRate(id, "26.2");
    await addItem(id, await addCategory(id, "Mains"), { name: "Stew", priceUsd: "7.77" });

    // 7.77 * 26.2 = 203.574
    const body = await page(menuToken);
    expect(body).toContain("ZiG 210");
    expect(body).not.toContain("203");
  });

  it("uses the restaurant's own rounding steps", async () => {
    const { id, menuToken } = await newRestaurant("Steps", "zig_only");
    await owner.db
      .update(restaurants)
      .set({ zigRoundingStep: "50" })
      .where(eq(restaurants.id, id));
    await setRate(id, "26.2");
    await addItem(id, await addCategory(id, "Mains"), { name: "Stew", priceUsd: "8" });

    expect(priceOf(await page(menuToken))).toContain("ZiG 250");
  });

  it("reprices every calculated ZiG item at the next render after the rate changes", async () => {
    const { id, menuToken } = await menuIn("zig_only");
    await addItem(id, await addCategory(id, "Drinks"), { name: "Fixed", priceUsd: "2", priceZig: "55" });
    expect(await page(menuToken)).toContain("ZiG 210");

    await setRate(id, "30");

    const body = await page(menuToken);
    expect(body).toContain("ZiG 240");
    expect(body).not.toContain("ZiG 210");
    expect(body).toContain("ZiG 55");
  });

  it("shows what it can until the first rate is set", async () => {
    const { id, menuToken } = await newRestaurant("No rate yet", "both");
    await addItem(id, await addCategory(id, "Mains"), { name: "Stew", priceUsd: "8" });

    expect(priceOf(await page(menuToken))).toBe('<span class="price">$8.00</span>');
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

describe("a sold-out item", () => {
  it("is labelled, and stays on the page", async () => {
    const { id, menuToken } = await newRestaurant("Sold out");
    await addItem(id, await addCategory(id, "Mains"), {
      name: "Beef stew",
      priceUsd: "8.50",
      available: false,
    });

    const body = await page(menuToken);

    expect(body).toContain("Beef stew");
    expect(body).toContain("Sold out");
    expect(body).toContain('class="sold-out"');
  });

  it("is greyed out and sorted after the items still on", async () => {
    const { id, menuToken } = await newRestaurant("Sorted last");
    const mains = await addCategory(id, "Mains");
    await addItem(id, mains, { name: "Gone steak", priceUsd: "21", sortOrder: 0, available: false });
    await addItem(id, mains, { name: "Stew", priceUsd: "8", sortOrder: 1 });
    await addItem(id, mains, { name: "Chicken", priceUsd: "9", sortOrder: 2 });

    const body = await page(menuToken);

    const positions = ["Stew", "Chicken", "Gone steak"].map((text) => body.indexOf(text));
    expect(positions).not.toContain(-1);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(body).toMatch(/class="sold-out"[\s\S]*Gone steak/);
  });

  it("keeps the sort order on both sides of the split, with prices, photos and no archived rows", async () => {
    const { id, menuToken } = await newRestaurant("Everything", "both");
    await setRate(id, "26.2");
    const mains = await addCategory(id, "Mains");
    await addItem(id, mains, { name: "Item C", priceUsd: "8", sortOrder: 3, available: false, photoKey: "menu/gone" });
    await addItem(id, mains, { name: "Item A", priceUsd: "8", sortOrder: 2, available: false });
    await addItem(id, mains, { name: "Item D", priceUsd: "8", sortOrder: 1, photoKey: "menu/on" });
    await addItem(id, mains, { name: "Item B", priceUsd: "8", sortOrder: 0 });
    await addItem(id, mains, { name: "Item E", priceUsd: "8", sortOrder: 0, archivedAt: new Date(), photoKey: "menu/archived" });

    const body = await page(menuToken);

    const order = ["Item B", "Item D", "Item A", "Item C"].map((name) => body.indexOf(name));
    expect(order.every((at) => at !== -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(body).not.toContain("Item E");
    expect(body).not.toContain("menu/archived");
    expect(body.match(/\$8\.00 · ZiG 210/g)).toHaveLength(4);
    expect(body.match(/Sold out/g)).toHaveLength(2);
    for (const key of ["menu/on", "menu/gone"]) {
      expect(body).toContain(
        `<img class="thumb" src="https://cdn.example.test/${key}-320.webp" width="64" height="64" loading="lazy"`,
      );
    }
    expect(body).not.toContain("<script");
  });

  it("doesn't mark an available item", async () => {
    const { id, menuToken } = await newRestaurant("Still on");
    await addItem(id, await addCategory(id, "Mains"), { name: "Stew", priceUsd: "8" });

    const body = await page(menuToken);

    expect(body).not.toContain("Sold out");
    expect(body).not.toContain('class="sold-out"');
  });
});

describe("specials", () => {
  const HOUR = 60 * 60 * 1000;
  const ago = (hours: number) => new Date(Date.now() - hours * HOUR);
  const ahead = (hours: number) => new Date(Date.now() + hours * HOUR);

  /** A $8 stew, and the special on it (any fields), in a restaurant at 26.2 ZiG to the dollar. */
  async function stewWith(
    fields: Partial<typeof specials.$inferInsert> | null,
    mode: "usd_only" | "zig_only" | "usd_primary" | "zig_primary" | "both" = "usd_only",
    item: { priceUsd?: string; priceZig?: string; available?: boolean; archivedAt?: Date } = { priceUsd: "8" },
    rate: string | null = "26.2",
  ) {
    const { id, menuToken } = await newRestaurant(`Promo ${mode}`, mode);
    if (rate !== null) await setRate(id, rate);
    const mains = await addCategory(id, "Mains");
    const [{ id: itemId }] = await owner.db
      .insert(menuItems)
      .values({ restaurantId: id, categoryId: mains, name: "Stew", ...item })
      .returning({ id: menuItems.id });
    if (fields !== null) {
      await owner.db
        .insert(specials)
        .values({ restaurantId: id, menuItemId: itemId, specialPriceUsd: "6", ...fields });
    }
    return { id, menuToken, itemId, mains };
  }

  const specialsSection = (body: string) =>
    /<section id="specials">[\s\S]*?<\/section>/.exec(body)?.[0] ?? "";

  it("shows no Specials section when no special is active", async () => {
    const { menuToken } = await stewWith(null);
    const body = await page(menuToken);
    expect(body).not.toContain("Specials");
    expect(body).not.toContain("<s>");
  });

  it("shows a Specials section above the categories, with the normal price struck through", async () => {
    const { menuToken } = await stewWith({ title: "Taco Tuesday", startsAt: ago(1), endsAt: ahead(1) });

    const body = await page(menuToken);

    const section = specialsSection(body);
    expect(section).toContain("<h2>Specials</h2>");
    expect(section).toContain("Stew");
    expect(section).toContain("Taco Tuesday");
    expect(section).toContain("<s>$8.00</s>");
    expect(section).toContain("$6.00");
    expect(body.indexOf("<h2>Specials</h2>")).toBeLessThan(body.indexOf("<h2>Mains</h2>"));
  });

  it("shows the same special price on the item in its category, so the two never disagree", async () => {
    const { menuToken } = await stewWith({ endsAt: ahead(1) });

    const body = await page(menuToken);

    const category = body.slice(body.indexOf("<h2>Mains</h2>"));
    expect(category).toContain("<s>$8.00</s>");
    expect(category).toContain("$6.00");
  });

  it("shows the special in both currencies under usd_primary: ZiG underneath, struck too", async () => {
    const { menuToken } = await stewWith({ endsAt: ahead(1) }, "usd_primary");

    const body = await page(menuToken);

    // 6 * 26.2 = 157.2 -> 160. The normal price is 8 * 26.2 = 209.6 -> 210.
    expect(specialsSection(body)).toContain(
      '<span class="price"><s>$8.00</s> $6.00<span class="sub"><s>ZiG 210</s> ZiG 160</span></span>',
    );
  });

  it("discounts a fixed ZiG price too, when only the dollar price is set (spec 00)", async () => {
    const { menuToken } = await stewWith(
      { endsAt: ahead(1) },
      "zig_only",
      { priceUsd: "8", priceZig: "250" },
    );

    expect(specialsSection(await page(menuToken))).toContain("<s>ZiG 250</s> ZiG 160");
  });

  it("puts a one-line struck price under both", async () => {
    const { menuToken } = await stewWith({ endsAt: ahead(1) }, "both");

    expect(specialsSection(await page(menuToken))).toContain("<s>$8.00 · ZiG 210</s> $6.00 · ZiG 160");
  });

  it("shows a badge-only special with the normal price and nothing struck", async () => {
    const { menuToken } = await stewWith({ title: "Chef's pick", specialPriceUsd: null });

    const body = await page(menuToken);

    expect(specialsSection(body)).toContain("Chef&#39;s pick");
    expect(specialsSection(body)).toContain("$8.00");
    expect(body).not.toContain("<s>");
  });

  it("badges a special that has a price and no title", async () => {
    const { menuToken } = await stewWith({ title: null });

    expect(specialsSection(await page(menuToken))).toContain(">Special</em>");
  });

  it("shows a special with no end date, until it is turned off", async () => {
    const { id, menuToken } = await stewWith({ startsAt: ago(24 * 400), endsAt: null });

    expect(specialsSection(await page(menuToken))).toContain("$6.00");

    await owner.db.update(specials).set({ active: false }).where(eq(specials.restaurantId, id));
    expect(await page(menuToken)).not.toContain("Specials");
  });

  it.each([
    ["has not started", () => ({ startsAt: ahead(1), endsAt: ahead(2) })],
    ["has ended", () => ({ startsAt: ago(2), endsAt: ago(1) })],
    ["is turned off", () => ({ active: false })],
  ])("shows nothing for a special that %s: the normal price stands", async (_name, window) => {
    const { menuToken } = await stewWith(window());

    const body = await page(menuToken);

    expect(body).not.toContain("Specials");
    expect(body).not.toContain("<s>");
    expect(body).toContain("$8.00");
    expect(body).not.toContain("$6.00");
  });

  it("shows nothing for a special on an archived item", async () => {
    const { menuToken } = await stewWith(
      { title: "Hidden deal" },
      "usd_only",
      { priceUsd: "8", archivedAt: new Date() },
    );

    const body = await page(menuToken);

    expect(body).not.toContain("Specials");
    expect(body).not.toContain("Hidden deal");
    expect(body).not.toContain("Stew");
  });

  it("shows a special on a sold-out item, greyed and labelled, after the others", async () => {
    const { id, menuToken, mains } = await stewWith({ title: "Gone deal" }, "usd_only", {
      priceUsd: "8",
      available: false,
    });
    const [{ id: pieId }] = await owner.db
      .insert(menuItems)
      .values({ restaurantId: id, categoryId: mains, name: "Pie", priceUsd: "5", sortOrder: 5 })
      .returning({ id: menuItems.id });
    await owner.db
      .insert(specials)
      .values({ restaurantId: id, menuItemId: pieId, title: "Pie deal", specialPriceUsd: "4" });

    const section = specialsSection(await page(menuToken));

    expect(section.indexOf("Pie")).toBeLessThan(section.indexOf("Stew"));
    expect(section).toMatch(/class="sold-out"[\s\S]*Stew[\s\S]*Sold out/);
    expect(section.match(/Sold out/g)).toHaveLength(1);
  });

  it("with no rate yet, strikes only what it can work out", async () => {
    // A ZiG special on a dollar-only item can't become dollars without a rate.
    const { menuToken } = await stewWith(
      { specialPriceUsd: null, specialPriceZig: "150" },
      "usd_primary",
      { priceUsd: "8" },
      null,
    );

    const body = await page(menuToken);

    expect(specialsSection(body)).toContain("ZiG 150");
    expect(specialsSection(body)).toContain("$8.00");
    expect(specialsSection(body)).not.toContain("<s>");
  });

  it("with no rate yet, a dollar special on a ZiG-only item keeps showing the item's ZiG price", async () => {
    const { menuToken } = await stewWith({ endsAt: ahead(1) }, "zig_only", { priceZig: "250" }, null);

    const body = await page(menuToken);

    expect(specialsSection(body)).toContain("ZiG 250");
    expect(specialsSection(body)).not.toContain("<s>");
  });

  it("for a ZiG-only item with a rate, shows the dollar special as ZiG, calculated", async () => {
    const { menuToken } = await stewWith({ endsAt: ahead(1) }, "zig_only", { priceZig: "250" });

    expect(specialsSection(await page(menuToken))).toContain("<s>ZiG 250</s> ZiG 160");
  });

  it("escapes a badge an owner typed", async () => {
    const { menuToken } = await stewWith({ title: "<img src=x onerror=alert(1)>" });

    const body = await page(menuToken);

    expect(body).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(body).not.toMatch(/<img src=x/);
  });

  it("keeps its own restaurant's specials: another's never show", async () => {
    const other = await stewWith({ title: "Their secret deal" });
    const { menuToken } = await stewWith(null);

    const body = await page(menuToken);

    expect(body).not.toContain("Their secret deal");
    expect(await page(other.menuToken)).toContain("Their secret deal");
  });

  it("stays inside the budget with 30 items on special, each shown twice", async () => {
    const { id, menuToken } = await newRestaurant("Thirty specials", "both");
    await setRate(id, "26.2");
    const categoryId = await addCategory(id, "Mains");
    for (let n = 0; n < 30; n += 1) {
      const [{ id: itemId }] = await owner.db
        .insert(menuItems)
        .values({
          restaurantId: id,
          categoryId,
          name: `Item ${n}`,
          description: "A sentence or two about what's in this and how it comes.",
          priceUsd: "12.50",
          photoKey: `menu/${crypto.randomUUID()}`,
        })
        .returning({ id: menuItems.id });
      await owner.db.insert(specials).values({
        restaurantId: id,
        menuItemId: itemId,
        title: "Taco Tuesday",
        specialPriceUsd: "9.50",
      });
    }

    const body = await page(menuToken);

    expect(body.match(/<s>/g)).toHaveLength(60);
    expect(new TextEncoder().encode(body).length).toBeLessThan(100_000);
    expect(body).not.toMatch(/<script|\son\w+=|javascript:/i);
  });
});
