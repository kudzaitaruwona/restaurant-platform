import { gzipSync } from "node:zlib";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GET as tablePage } from "@/app/t/[qrToken]/route";
import {
  categories,
  diningTables,
  exchangeRates,
  menuItems,
  restaurants,
  specials,
  staff,
} from "@/db/schema";
import { mintQrToken } from "@/lib/qr-token";
import {
  openOwnerDatabase,
  testDatabaseSettings,
} from "../../../../test/integration/database";
import { GET } from "./route";

vi.mock("next/cache", () => ({ cacheTag: vi.fn(), cacheLife: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/storage", () => ({
  getUrl: (key: string) => `https://images.example.com/restaurants/menu/${key}`,
}));

/**
 * The performance budget's repeatable check (spec 02, issue 26): the public page
 * for a realistic 30-item menu with a photo on every item, measured in bytes
 * before any image. Runs in CI as part of `npm run test:integration`, and alone
 * as `npm run test:budget`. MENU_BUDGET_BYTES lowers or raises the limit, which
 * is how to see it fail: `MENU_BUDGET_BYTES=1000 npm run test:budget`.
 */
const BUDGET_BYTES = Number(process.env.MENU_BUDGET_BYTES ?? 100 * 1024);

const owner = openOwnerDatabase();
let restaurantId = "";
let menuToken = "";
let body = "";
let tableBody = "";

beforeAll(async () => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
  restaurantId = crypto.randomUUID();
  menuToken = `budget-${restaurantId}`;
  await owner.db.insert(restaurants).values({
    id: restaurantId,
    name: "The Long Table Restaurant and Bar",
    slug: `budget-${restaurantId}`,
    menuToken,
    currencyMode: "both",
    wifiName: "LongTable-Guest",
  });
  const [{ id: setBy }] = await owner.db
    .insert(staff)
    .values({ restaurantId, email: `${restaurantId}@example.test`, displayName: "Rate setter" })
    .returning({ id: staff.id });
  await owner.db.insert(exchangeRates).values({ restaurantId, setBy, usdToZig: "26.2" });

  const names = ["Starters", "Mains", "Grill", "Sides", "Desserts", "Drinks"];
  for (const [index, name] of names.entries()) {
    const [{ id: categoryId }] = await owner.db
      .insert(categories)
      .values({ restaurantId, name, sortOrder: index })
      .returning({ id: categories.id });
    // 5 items each: 30 in all, each with a photo and a typical description.
    const rows = await owner.db
      .insert(menuItems)
      .values(
        Array.from({ length: 5 }, (_, n) => ({
          restaurantId,
          categoryId,
          name: `${name} dish number ${n + 1} with a fairly long name`,
          description:
            "Slow-cooked and served with sadza, seasonal greens and a house relish; ask your server about today's variations and portion sizes.",
          priceUsd: "8.50",
          photoKey: `${restaurantId}/${crypto.randomUUID()}`,
          sortOrder: n,
        })),
      )
      .returning({ id: menuItems.id });
    if (index < 2) {
      await owner.db.insert(specials).values(
        rows.slice(0, 2).map((row) => ({
          restaurantId,
          menuItemId: row.id,
          title: "Chef's special",
          specialPriceUsd: "6.50",
        })),
      );
    }
  }
  // A bundle too, so the Specials section carries one as it does on a real page.
  const [{ id: categoryId }] = await owner.db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.restaurantId, restaurantId))
    .limit(1);
  const [{ id: bundleId }] = await owner.db
    .insert(menuItems)
    .values({
      restaurantId,
      categoryId,
      name: "Lunch combo: burger, chips and a drink",
      description: "A burger, a portion of chips and a cold drink, with sauce on the side.",
      priceUsd: "12.50",
      photoKey: `${restaurantId}/${crypto.randomUUID()}`,
      visibility: "special_only",
    })
    .returning({ id: menuItems.id });
  await owner.db
    .insert(specials)
    .values({ restaurantId, menuItemId: bundleId, title: "Lunch combo" });
  const response = await GET(new Request(`http://localhost:3000/m/${menuToken}`), {
    params: Promise.resolve({ menuToken }),
  });
  body = await response.text();

  const qrToken = mintQrToken();
  await owner.db
    .insert(diningTables)
    .values({ restaurantId, label: "7", capacity: 4, qrToken });
  const scanned = await tablePage(new Request(`http://localhost:3000/t/${qrToken}`), {
    params: Promise.resolve({ qrToken }),
  });
  tableBody = await scanned.text();
});

afterAll(async () => {
  await owner.db.delete(specials).where(inArray(specials.restaurantId, [restaurantId]));
  await owner.db.delete(exchangeRates).where(inArray(exchangeRates.restaurantId, [restaurantId]));
  await owner.db.delete(staff).where(inArray(staff.restaurantId, [restaurantId]));
  await owner.db.delete(menuItems).where(inArray(menuItems.restaurantId, [restaurantId]));
  await owner.db.delete(categories).where(inArray(categories.restaurantId, [restaurantId]));
  await owner.db.delete(diningTables).where(inArray(diningTables.restaurantId, [restaurantId]));
  await owner.db.delete(restaurants).where(inArray(restaurants.id, [restaurantId]));
  await owner.pool.end();
  vi.unstubAllEnvs();
});

describe("public menu page weight, 30 items with photos", () => {
  it("is a realistic page", () => {
    expect(body.match(/<li[ >]/g)?.length).toBeGreaterThanOrEqual(30);
    expect(body.match(/<img /g)?.length).toBeGreaterThanOrEqual(30);
  });

  it(`is under the budget (${BUDGET_BYTES} bytes) before images`, () => {
    const bytes = Buffer.byteLength(body);
    console.log(
      `public menu page: ${bytes} bytes raw, ${gzipSync(body).length} gzipped, budget ${BUDGET_BYTES}`,
    );
    expect(bytes).toBeLessThan(BUDGET_BYTES);
  });

  it("a table's code serves the same page, so the same budget", () => {
    expect(tableBody).toBe(body);
    expect(Buffer.byteLength(tableBody)).toBeLessThan(BUDGET_BYTES);
  });

  it("loads every image lazily at a fixed size, and ships no script", () => {
    const images = body.match(/<img [^>]*>/g) ?? [];
    for (const image of images) {
      expect(image).toContain('loading="lazy"');
      expect(image).toMatch(/width="\d+"/);
      expect(image).toMatch(/height="\d+"/);
    }
    expect(body).not.toContain("<script");
  });
});
