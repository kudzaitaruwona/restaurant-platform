import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as setRate } from "@/app/api/menu/exchange-rate/route";
import { POST as editItem } from "@/app/api/menu/items/[itemId]/route";
import { POST as addSpecial } from "@/app/api/menu/specials/route";
import { POST as turnSpecial } from "@/app/api/menu/specials/[specialId]/active/route";
import { POST as saveSettings } from "@/app/api/restaurant/route";
import { auditLog, categories, exchangeRates, menuItems, restaurants, specials, staff } from "@/db/schema";
import type { CurrencyMode } from "@/lib/pricing";
import type { TenantContext } from "@/lib/tenant";
import { openOwnerDatabase, testDatabaseSettings } from "../../../../test/integration/database";
import { MenuScreen } from "./menu-screen";

/**
 * Later edits and a special's price (issue #129): what the owner is told when an
 * item, rate, turn-on or currency change would leave a special above its item's
 * normal price. Postgres holds the rule: src/db/special-prices.int.test.ts.
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

let restaurantId: string;
let staffId: string;
let categoryId: string;

beforeEach(async () => {
  restaurantId = crypto.randomUUID();
  staffId = crypto.randomUUID();
  await owner.db.insert(restaurants).values({
    id: restaurantId,
    name: "Mama's Kitchen",
    slug: `lifted-${restaurantId}`,
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
  [{ id: categoryId }] = await owner.db
    .insert(categories)
    .values({ restaurantId, name: "Mains" })
    .returning({ id: categories.id });
  session.tenant = { restaurantId, staffId, role: "owner" } satisfies TenantContext;
});

const post = (path: string, fields: Record<string, string> = {}) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return new NextRequest(new URL(path, "http://localhost:3000"), { method: "POST", body });
};
const newItem = async (name: string, priceUsd: string | null, priceZig: string | null = null) => {
  const [{ id }] = await owner.db
    .insert(menuItems)
    .values({ restaurantId, categoryId, name, priceUsd, priceZig })
    .returning({ id: menuItems.id });
  return id;
};
const newSpecial = async (
  menuItemId: string,
  specialPriceUsd: string | null,
  fields: Partial<typeof specials.$inferInsert> = {},
) => {
  const [{ id }] = await owner.db
    .insert(specials)
    .values({ restaurantId, menuItemId, title: "Lunch deal", specialPriceUsd, ...fields })
    .returning({ id: specials.id });
  return id;
};
const rateOf = (usdToZig: string) => owner.db.insert(exchangeRates).values({ restaurantId, usdToZig, setBy: staffId });
const mode = (currencyMode: CurrencyMode) =>
  owner.db.update(restaurants).set({ currencyMode }).where(eq(restaurants.id, restaurantId));

const edit = (id: string, fields: Record<string, string>) =>
  editItem(post(`/api/menu/items/${id}`, { name: "Burger", description: "", categoryId, ...fields }), {
    params: Promise.resolve({ itemId: id }),
  });
const turn = (id: string, active: boolean) =>
  turnSpecial(post(`/api/menu/specials/${id}/active`, { active: String(active) }), {
    params: Promise.resolve({ specialId: id }),
  });
const settings = (currencyMode: CurrencyMode, fields: Record<string, string> = {}) =>
  saveSettings(
    post("/api/restaurant", {
      name: "Renamed",
      contactPhone: "",
      wifiName: "",
      wifiPassword: "",
      currencyMode,
      timezone: "Africa/Harare",
      ...fields,
    }),
  );
const refusal = async (response: Response) => {
  expect(response.status).toBe(400);
  return (await response.json()).error as string;
};

describe("editing an item", () => {
  it("is refused when it would leave a special above the new price, and changes nothing", async () => {
    const id = await newItem("Burger", "10");
    await newSpecial(id, "8");

    expect(await refusal(await edit(id, { priceUsd: "7" }))).toBe(
      'This would leave a special above the normal price: "Lunch deal" on Burger ($8.00, normally $7.00). Turn it off under Specials on the Menu page first.',
    );
    const [row] = await owner.db.select().from(menuItems).where(eq(menuItems.id, id));
    expect(row.priceUsd).toBe("10");

    expect((await edit(id, { priceUsd: "8" })).status).toBe(303);
  });

  it("is refused even when the post says it was confirmed", async () => {
    const id = await newItem("Burger", "10");
    await newSpecial(id, "8");
    await refusal(await edit(id, { priceUsd: "7", confirmed: "1" }));
  });

  it("saves the other fields with the special as it is, and the price once the special is off", async () => {
    const id = await newItem("Burger", "10");
    const special = await newSpecial(id, "8");
    expect((await edit(id, { priceUsd: "10", description: "Beef" })).status).toBe(303);
    expect((await turn(special, false)).status).toBe(303);
    expect((await edit(id, { priceUsd: "7" })).status).toBe(303);
  });

  it("says a special's price is calculated when it is", async () => {
    await rateOf("26.2");
    const id = await newItem("Burger", "10");
    await newSpecial(id, "9", { title: null });
    expect(await refusal(await edit(id, { priceUsd: "10", priceZig: "200" }))).toBe(
      "This would leave a special above the normal price: Burger (ZiG 240 calculated, normally ZiG 200). Turn it off under Specials on the Menu page first.",
    );
  });
});

describe("a new exchange rate", () => {
  const rates = async () =>
    (await owner.db.select().from(exchangeRates).where(eq(exchangeRates.restaurantId, restaurantId))).length;

  it("is refused naming every special it would leave above, and saves and audits nothing", async () => {
    await rateOf("20");
    await newSpecial(await newItem("Burger", "10", "200"), "9");
    await newSpecial(await newItem("Chips", "5", "100"), "4.50", { title: null });
    await newSpecial(await newItem("Soda", "2"), "1");

    expect(await refusal(await setRate(post("/api/menu/exchange-rate", { usdToZig: "26.2" })))).toBe(
      'This would leave 2 specials above the normal price: "Lunch deal" on Burger (ZiG 240 calculated, normally ZiG 200), Chips (ZiG 120 calculated, normally ZiG 100). Turn them off under Specials on the Menu page first.',
    );
    expect(await rates()).toBe(1);
    expect(await owner.db.select().from(auditLog).where(eq(auditLog.restaurantId, restaurantId))).toEqual([]);
  });

  it("names five and counts the rest", async () => {
    await rateOf("20");
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      await newSpecial(await newItem(`Dish ${n}`, "10", "200"), "9", { title: null });
    }
    const error = await refusal(await setRate(post("/api/menu/exchange-rate", { usdToZig: "26.2" })));
    expect(error).toContain("7 specials");
    expect(error).toContain("Dish 5 (ZiG 240 calculated, normally ZiG 200) and 2 more. Turn them off");
    expect(error).not.toContain("Dish 6");
  });

  it("saves when the currency it would lift isn't shown", async () => {
    await mode("usd_only");
    await rateOf("20");
    await newSpecial(await newItem("Burger", "10", "200"), "9");
    expect((await setRate(post("/api/menu/exchange-rate", { usdToZig: "26.2" }))).status).toBe(303);
    expect(await rates()).toBe(2);
  });
});

describe("turning a special on", () => {
  it("is refused when the normal price has gone under it, and leaves it off", async () => {
    const id = await newItem("Burger", "7");
    const special = await newSpecial(id, "8", { active: false });

    expect(await refusal(await turn(special, true))).toBe(
      "The special USD price ($8.00) is above the normal price ($7.00) now, so it can't be turned on. Change the item's price, or add another special.",
    );
    const [row] = await owner.db.select().from(specials).where(eq(specials.id, special));
    expect(row.active).toBe(false);
  });

  it("is refused when the rate has lifted its calculated price, only if the menu shows it", async () => {
    await rateOf("26.2");
    const id = await newItem("Burger", "10", "200");
    const special = await newSpecial(id, "9", { active: false });
    expect(await refusal(await turn(special, true))).toBe(
      "At the current rate this special's ZiG price is calculated as ZiG 240, above the normal price (ZiG 200), so it can't be turned on. Change the item's price, or add another special.",
    );
    await mode("usd_only");
    expect((await turn(special, true)).status).toBe(303);
  });
});

describe("adding a special", () => {
  it("compares only what the menu shows", async () => {
    await rateOf("26.2");
    await mode("usd_only");
    const id = await newItem("Burger", "10", "200");
    expect((await addSpecial(post("/api/menu/specials", { menuItemId: id, priceUsd: "9" }))).status).toBe(303);
  });

  it("is told that equal is allowed, by the form as by the refusal", async () => {
    const id = await newItem("Burger", "10");
    const error = await refusal(await addSpecial(post("/api/menu/specials", { menuItemId: id, priceUsd: "10.01" })));
    expect(error).toContain("can't be above it");
    expect(error).not.toMatch(/lower|below/i);

    const html = (await renderToStaticMarkup(await MenuScreen())).replaceAll("<!-- -->", "");
    expect(html).toContain("A price in one currency discounts both, and can’t be above the normal price.");
    expect(html).not.toContain("below the normal price");
  });
});

describe("saving settings", () => {
  it("is refused when the new currency mode would show a special above its normal price", async () => {
    await mode("usd_only");
    await rateOf("26.2");
    const special = await newSpecial(await newItem("Burger", "10", "200"), "9");

    const response = await settings("both");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error:
        'This would leave a special above the normal price: "Lunch deal" on Burger (ZiG 240 calculated, normally ZiG 200). Turn it off under Specials on the Menu page first.',
      field: "currencyMode",
    });
    const [row] = await owner.db.select().from(restaurants).where(eq(restaurants.id, restaurantId));
    expect(row).toMatchObject({ name: "Mama's Kitchen", currencyMode: "usd_only" });

    expect((await settings("usd_only")).status).toBe(303);
    await turn(special, false);
    expect((await settings("both")).status).toBe(303);
  });
});
