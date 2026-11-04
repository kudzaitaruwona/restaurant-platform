import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GET as menuPage } from "@/app/m/[menuToken]/route";
import {
  auditLog,
  categories,
  diningTables,
  exchangeRates,
  menuItems,
  restaurants,
  specials,
  staff,
} from "@/db/schema";
import { BUILD_SAMPLE_TOKEN } from "@/lib/public-menu";
import { mintQrToken } from "@/lib/qr-token";
import {
  openOwnerDatabase,
  testDatabaseSettings,
} from "../../../../test/integration/database";
import { GET, generateStaticParams } from "./route";

vi.mock("next/cache", () => ({
  cacheTag: vi.fn(),
  cacheLife: vi.fn(),
  revalidateTag: vi.fn(),
}));

// Photo addresses come from the storage interface; nothing here reaches R2.
vi.mock("@/lib/storage", () => ({
  getUrl: (key: string) => `https://cdn.example.test/${key}`,
}));

/**
 * A table's QR code, against a real Postgres as app_tenant. Until ordering
 * arrives it shows the same menu as the generic code (spec 03). `use cache` is
 * inert here: test/production/public-pages.test.ts runs the real cache.
 */
const owner = openOwnerDatabase();
const created: string[] = [];

async function newRestaurant(name: string, dish: string) {
  const id = crypto.randomUUID();
  await owner.db.insert(restaurants).values({
    id,
    name,
    slug: `table-qr-${id}`,
    menuToken: `menu-${id}`,
    currencyMode: "usd_only",
    wifiPassword: "kept-off-the-page",
  });
  created.push(id);
  const [{ id: categoryId }] = await owner.db
    .insert(categories)
    .values({ restaurantId: id, name: "Mains" })
    .returning({ id: categories.id });
  await owner.db
    .insert(menuItems)
    .values({ restaurantId: id, categoryId, name: dish, priceUsd: "8" });
  const qrToken = mintQrToken();
  await owner.db
    .insert(diningTables)
    .values({ restaurantId: id, label: "Table Seven", capacity: 4, qrToken });
  return { id, menuToken: `menu-${id}`, qrToken, categoryId };
}

const scan = (qrToken: string) =>
  GET(new Request(`http://localhost:3000/t/${qrToken}`), {
    params: Promise.resolve({ qrToken }),
  });

beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});

afterAll(async () => {
  await owner.db.delete(specials).where(inArray(specials.restaurantId, created));
  await owner.db.delete(exchangeRates).where(inArray(exchangeRates.restaurantId, created));
  await owner.db.delete(staff).where(inArray(staff.restaurantId, created));
  await owner.db.delete(menuItems).where(inArray(menuItems.restaurantId, created));
  await owner.db.delete(categories).where(inArray(categories.restaurantId, created));
  await owner.db.delete(diningTables).where(inArray(diningTables.restaurantId, created));
  await owner.db.delete(restaurants).where(inArray(restaurants.id, created));
  await owner.pool.end();
  vi.unstubAllEnvs();
});

describe("/t/{qr_token}", () => {
  it("renders the same menu as the restaurant's /m/{menu_token}", async () => {
    const { menuToken, qrToken } = await newRestaurant("Mama's Kitchen", "Beef stew");

    const table = await scan(qrToken);
    const generic = await menuPage(new Request(`http://localhost:3000/m/${menuToken}`), {
      params: Promise.resolve({ menuToken }),
    });

    expect(table.status).toBe(200);
    expect(table.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const body = await table.text();
    expect(body).toContain("Mama&#39;s Kitchen");
    expect(body).toContain("Beef stew");
    expect(body).toBe(await generic.text());
  });

  it("renders everything the menu page does, byte for byte", async () => {
    const { id, menuToken, qrToken, categoryId } = await newRestaurant("Full menu", "Beef stew");
    await owner.db
      .update(restaurants)
      .set({ currencyMode: "usd_primary", wifiName: "Guest-Net" })
      .where(eq(restaurants.id, id));
    const [{ id: setBy }] = await owner.db
      .insert(staff)
      .values({ restaurantId: id, email: `${id}@example.test`, displayName: "Rate setter" })
      .returning({ id: staff.id });
    await owner.db.insert(exchangeRates).values({ restaurantId: id, setBy, usdToZig: "26.2" });
    const [promoted, bundle] = await owner.db
      .insert(menuItems)
      .values([
        { restaurantId: id, categoryId, name: "Grilled bream", priceUsd: "10", photoKey: `${id}/bream` },
        { restaurantId: id, categoryId, name: "Lunch combo", priceUsd: "12", visibility: "special_only" },
        { restaurantId: id, categoryId, name: "Oxtail", priceUsd: "14", available: false },
      ])
      .returning({ id: menuItems.id });
    await owner.db.insert(specials).values([
      { restaurantId: id, menuItemId: promoted.id, title: "Fish Friday", specialPriceUsd: "7" },
      { restaurantId: id, menuItemId: bundle.id, title: "Lunch deal" },
    ]);

    const body = await (await scan(qrToken)).text();
    const generic = await menuPage(new Request(`http://localhost:3000/m/${menuToken}`), {
      params: Promise.resolve({ menuToken }),
    });

    expect(body).toBe(await generic.text());
    expect(body).toContain("Wi-Fi: Guest-Net");
    expect(body).not.toContain("kept-off-the-page");
    expect(body).toContain('<nav aria-label="Menu sections"><a href="#specials">Specials</a>');
    expect(body).toContain("Fish Friday");
    expect(body).toContain("Lunch combo");
    expect(body).toContain("<s>$10.00</s>");
    expect(body).toContain('class="sub"');
    expect(body).toContain("ZiG");
    expect(body).toContain(`https://cdn.example.test/${id}/bream`);
    expect(body).toContain("Sold out");
  });

  it("shows its own restaurant's menu and nobody else's", async () => {
    const [mine, theirs] = [
      await newRestaurant("Mine", "My stew"),
      await newRestaurant("Theirs", "Their stew"),
    ];

    const body = await (await scan(mine.qrToken)).text();

    expect(body).toContain("My stew");
    expect(body).not.toContain("Their");
    expect(await (await scan(theirs.qrToken)).text()).toContain("Their stew");
  });

  it("puts no label, id or Wi-Fi password on the page", async () => {
    const { id, categoryId, qrToken } = await newRestaurant("Private", "Stew");

    const body = await (await scan(qrToken)).text();

    expect(body).not.toContain("Table Seven");
    expect(body).not.toContain(id);
    expect(body).not.toContain(categoryId);
    expect(body).not.toContain("kept-off-the-page");
  });

  it("has no JavaScript, like the menu it shows", async () => {
    const { qrToken } = await newRestaurant("No scripts", "Stew");
    expect(await (await scan(qrToken)).text()).not.toMatch(/<script|\son\w+=|javascript:/i);
  });

  it("says the code is out of date for a token that was never a table's, as a real 404", async () => {
    for (const token of ["no-such-token", mintQrToken(), "%", "' or 1=1 --"]) {
      const response = await scan(token);

      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const body = await response.text();
      expect(body).toContain("This code is out of date");
      expect(body).toContain("Ask a member of staff");
    }
  });

  it("answers a NUL in the token with the out-of-date page, not a 500", async () => {
    // /t/%00 decodes to a NUL, which Postgres can't store in text.
    const response = await scan("\0");

    expect(response.status).toBe(404);
    expect(await response.text()).toContain("This code is out of date");
  });

  it("doesn't take a restaurant's menu token for a table's", async () => {
    const { menuToken } = await newRestaurant("Menu token", "Stew");
    expect((await scan(menuToken)).status).toBe(404);
  });

  it("is out of date once the table is archived", async () => {
    const { id, qrToken } = await newRestaurant("Archived", "Stew");
    expect((await scan(qrToken)).status).toBe(200);

    await owner.db
      .update(diningTables)
      .set({ archivedAt: new Date() })
      .where(inArray(diningTables.restaurantId, [id]));

    expect((await scan(qrToken)).status).toBe(404);
  });

  it("logs nothing about the scan, and writes nothing", async () => {
    const { id, qrToken } = await newRestaurant("Unlogged", "Stew");
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );

    try {
      await scan(qrToken);
      await scan("no-such-token");
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(
      await owner.db.select().from(auditLog).where(inArray(auditLog.restaurantId, [id])),
    ).toEqual([]);
  });
});

describe("the build", () => {
  it("offers one sample token, because Cache Components won't take none", async () => {
    expect(await generateStaticParams()).toEqual([{ qrToken: BUILD_SAMPLE_TOKEN }]);
  });

  it("answers the sample without a restaurant: the build has no database", async () => {
    expect((await scan(BUILD_SAMPLE_TOKEN)).status).toBe(404);
  });
});
