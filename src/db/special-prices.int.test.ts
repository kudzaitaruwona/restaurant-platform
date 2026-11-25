import type { PoolClient } from "@neondatabase/serverless";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CurrencyMode,
  effectiveUsd,
  effectiveZig,
  specialUsd,
  specialZig,
} from "@/lib/pricing";
import { openOwnerDatabase, openTestDatabase } from "../../test/integration/database";
import { categories, exchangeRates, menuItems, restaurants, specials, staff } from "./schema";

/**
 * What Postgres holds about a special and its item's normal price (issue #129):
 * a special that is on, or still to start, is never above it, whichever of the
 * special, the item, the rate or the restaurant's settings moves, and whichever
 * of two of them commits first.
 */
const app = openTestDatabase();
const owner = openOwnerDatabase();

const RULE = "specials_not_above_normal";

afterAll(async () => {
  await Promise.all([app.pool.end(), owner.pool.end()]);
});

let restaurantId: string;
let staffId: string;
let categoryId: string;

beforeEach(async () => {
  restaurantId = crypto.randomUUID();
  staffId = crypto.randomUUID();
  await owner.db.insert(restaurants).values({
    id: restaurantId,
    name: "Special prices",
    slug: `special-prices-${restaurantId}`,
    menuToken: restaurantId,
    currencyMode: "both",
  });
  await owner.db.insert(staff).values({
    id: staffId,
    restaurantId,
    email: `${staffId}@example.test`,
    displayName: "Owner",
    role: "owner",
  });
  [{ id: categoryId }] = await owner.db
    .insert(categories)
    .values({ restaurantId, name: "Mains" })
    .returning({ id: categories.id });
});

const item = async (priceUsd: string | null, priceZig: string | null = null, fields = {}) => {
  const [{ id }] = await owner.db
    .insert(menuItems)
    .values({ restaurantId, categoryId, name: "Burger", priceUsd, priceZig, ...fields })
    .returning({ id: menuItems.id });
  return id;
};
const special = async (
  menuItemId: string,
  prices: { usd?: string; zig?: string },
  fields: Partial<typeof specials.$inferInsert> = {},
) => {
  const [{ id }] = await owner.db
    .insert(specials)
    .values({
      restaurantId,
      menuItemId,
      title: "Lunch deal",
      specialPriceUsd: prices.usd ?? null,
      specialPriceZig: prices.zig ?? null,
      ...fields,
    })
    .returning({ id: specials.id });
  return id;
};
const rate = (usdToZig: string) =>
  owner.db.insert(exchangeRates).values({ restaurantId, usdToZig, setBy: staffId });
const priceItem = (id: string, prices: { priceUsd?: string | null; priceZig?: string | null }) =>
  owner.db.update(menuItems).set(prices).where(eq(menuItems.id, id));
const mode = (currencyMode: CurrencyMode) =>
  owner.db.update(restaurants).set({ currencyMode }).where(eq(restaurants.id, restaurantId));
const turn = (id: string, active: boolean) =>
  owner.db.update(specials).set({ active }).where(eq(specials.id, id));

const constraintOf = (error: unknown) =>
  (error as { cause?: { constraint?: string } }).cause?.constraint ??
  (error as { constraint?: string }).constraint;
const outcome = (statement: PromiseLike<unknown>) =>
  statement.then(
    () => "saved",
    (error: unknown) => constraintOf(error) ?? String(error),
  );
const refused = async (statement: PromiseLike<unknown>) => expect(await outcome(statement)).toBe(RULE);
const saved = async (statement: PromiseLike<unknown>) => expect(await outcome(statement)).toBe("saved");

const past = (days: number) => new Date(Date.now() - days * 86_400_000);

describe("an item's price", () => {
  it("can't go under a special of it, and can go down to it", async () => {
    const id = await item("10");
    await special(id, { usd: "8" });
    await refused(priceItem(id, { priceUsd: "7.99" }));
    await saved(priceItem(id, { priceUsd: "8" }));
  });

  it("is held by a special still to start, and not by one that is off, over, or a badge alone", async () => {
    const scheduled = await item("10");
    await special(scheduled, { usd: "8" }, { startsAt: past(-2) });
    await refused(priceItem(scheduled, { priceUsd: "7" }));

    const free = await item("10");
    await special(free, { usd: "8" }, { active: false });
    await special(free, { usd: "8" }, { startsAt: past(3), endsAt: past(1) });
    await special(free, {}, { startsAt: new Date() });
    await saved(priceItem(free, { priceUsd: "7" }));
  });

  it("can't be fixed in ZiG under what a USD special is calculated as", async () => {
    await rate("26.2");
    const id = await item("10");
    await special(id, { usd: "9" });
    await refused(priceItem(id, { priceZig: "200" }));
    await saved(priceItem(id, { priceZig: "240" }));
    // Clearing the USD price makes the ZiG price the only one: ZiG 240 is $9.17.
    await saved(priceItem(id, { priceUsd: null }));
    await refused(priceItem(id, { priceZig: "230" }));
  });

  it("is not looked at on an archived item, until it comes back", async () => {
    const id = await item("10", null, { archivedAt: new Date() });
    await special(id, { usd: "12" });
    await saved(priceItem(id, { priceUsd: "11" }));
    await refused(owner.db.update(menuItems).set({ archivedAt: null }).where(eq(menuItems.id, id)));
  });
});

describe("an exchange rate", () => {
  it("can't lift a USD special's calculated ZiG price over a fixed one", async () => {
    await rate("20");
    const id = await item("10", "200");
    await special(id, { usd: "9" });
    await refused(rate("26.2"));
    await saved(rate("22"));
    const rows = await owner.db.select().from(exchangeRates).where(eq(exchangeRates.restaurantId, restaurantId));
    expect(rows.map((row) => row.usdToZig).sort()).toEqual(["20", "22"]);
  });

  it("can't drop a ZiG-priced item's USD price under a USD special, the first rate included", async () => {
    const id = await item(null, "210");
    await special(id, { usd: "8" });
    await refused(rate("30"));
    await saved(rate("26.2"));
    await refused(rate("27"));
  });

  it("can't drop a USD-priced item's ZiG price under a ZiG special", async () => {
    await rate("26.2");
    const id = await item("10");
    await special(id, { zig: "260" });
    await refused(rate("24"));
    await saved(rate("30"));
  });

  it("of another restaurant changes nothing here", async () => {
    await rate("20");
    const id = await item("10", "200");
    await special(id, { usd: "9" });
    const otherId = crypto.randomUUID();
    const otherStaff = crypto.randomUUID();
    await owner.db.insert(restaurants).values({
      id: otherId,
      name: "Other",
      slug: `special-prices-${otherId}`,
      menuToken: otherId,
      currencyMode: "both",
    });
    await owner.db.insert(staff).values({
      id: otherStaff,
      restaurantId: otherId,
      email: `${otherStaff}@example.test`,
      displayName: "Other",
      role: "owner",
    });
    await saved(owner.db.insert(exchangeRates).values({ restaurantId: otherId, usdToZig: "99", setBy: otherStaff }));
  });
});

describe("a special", () => {
  it("can't be added above the normal price, and can be added equal to it", async () => {
    const id = await item("10");
    await refused(special(id, { usd: "10.01" }));
    await saved(special(id, { usd: "10" }));
  });

  it("is not refused for the rounding alone on an item that fixes one price", async () => {
    await rate("26.2");
    await saved(special(await item("10"), { zig: "270" })); // $10.31 back
    await saved(special(await item(null, "210"), { usd: "8.02" })); // ZiG 220 back
    await refused(special(await item("10"), { zig: "271" }));
    await refused(special(await item(null, "210"), { usd: "8.03" }));
  });

  it("can't be turned on again once the normal price is under it, and can always be turned off", async () => {
    const id = await item("10");
    const lunch = await special(id, { usd: "8" });
    await saved(turn(lunch, false));
    await saved(priceItem(id, { priceUsd: "7" }));
    await refused(turn(lunch, true));
    await saved(turn(lunch, false));
    await saved(priceItem(id, { priceUsd: "8" }));
    await saved(turn(lunch, true));
  });

  it("that was above before the rule existed stops nothing but itself being left there", async () => {
    const id = await item("10");
    const other = await item("5");
    const lunch = await special(id, { usd: "8" });
    await owner.db.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx.update(menuItems).set({ priceUsd: "7" }).where(eq(menuItems.id, id));
    });
    // Other items and their specials carry on, and the fix is a tap.
    await saved(special(other, { usd: "4" }));
    await saved(priceItem(other, { priceUsd: "4.50" }));
    await saved(owner.db.update(menuItems).set({ name: "Bun", sortOrder: 4 }).where(eq(menuItems.id, id)));
    await refused(rate("26.2"));
    await saved(turn(lunch, false));
    await saved(rate("26.2"));
  });
});

describe("currency_mode", () => {
  it("leaves out a currency the menu doesn't show, calculated or typed", async () => {
    await mode("usd_only");
    await rate("26.2");
    const id = await item("10", "200");
    await saved(special(id, { usd: "9" })); // ZiG 240, shown nowhere
    const both = await item("10", "200");
    await saved(special(both, { usd: "9", zig: "300" }));
    await saved(rate("40"));
    await refused(priceItem(id, { priceUsd: "8" }));
  });

  it("mirrors that for zig_only", async () => {
    await mode("zig_only");
    await rate("26.2");
    const id = await item("5", "500");
    await saved(special(id, { zig: "400" })); // $15.27, shown nowhere
    await refused(priceItem(id, { priceZig: "390" }));
  });

  it("still compares what is shown when the price typed is in the other currency", async () => {
    await mode("usd_only");
    await rate("26.2");
    await refused(special(await item("10"), { zig: "500" })); // $19.09
    await refused(special(await item("5", "500"), { zig: "400" })); // $15.27
  });

  it("compares the currency shown instead when its own can't be worked out yet", async () => {
    await mode("usd_only");
    await refused(special(await item(null, "210"), { zig: "220" }));
    await mode("zig_only");
    await refused(special(await item("10"), { usd: "11" }));
  });

  it.each(["both", "usd_primary", "zig_primary", "zig_only"] as const)(
    "can't change to %s when that shows a special above its normal price",
    async (to) => {
      await mode("usd_only");
      await rate("26.2");
      const id = await item("10", "200");
      const lunch = await special(id, { usd: "9" });
      await refused(mode(to));
      await turn(lunch, false);
      await saved(mode(to));
    },
  );

  it("can't change a rounding step into one either", async () => {
    await rate("26.2");
    const id = await item("10", "240");
    await special(id, { usd: "9" }); // ZiG 240
    const step = (zigRoundingStep: string) =>
      owner.db.update(restaurants).set({ zigRoundingStep }).where(eq(restaurants.id, restaurantId));
    await refused(step("50"));
    await saved(step("5"));
  });
});

describe("the sums", () => {
  /** Postgres's answer beside "@/lib/pricing"'s, which the menu shows. */
  it("are the menu's own, to the cent and the step, in every mode", async () => {
    const prices = ["0", "0.01", "8.02", "9.99", "10", "210", "270.5", null];
    const rates = [null, "0.37", "13.9987", "26.2", "29.97"];
    const modes = ["usd_only", "zig_only", "usd_primary", "zig_primary", "both"] as const;
    const cases: (string | null)[][] = [];
    for (const itemUsd of prices)
      for (const itemZig of prices)
        for (const usd of prices)
          for (const zig of prices)
            for (const r of rates) {
              if ((itemUsd ?? itemZig) === null) continue;
              cases.push([itemUsd, itemZig, usd, zig, r, modes[cases.length % modes.length]]);
            }

    const { rows } = await owner.db.execute<{ n: number; currency: string | null; special: string | null; normal: string | null }>(sql`
      select c.n::int, a.currency, a.special::text, a.normal::text
      from jsonb_array_elements(${JSON.stringify(cases)}::jsonb) with ordinality c(v, n)
      left join lateral special_above_normal(
        (v->>0)::numeric, (v->>1)::numeric, (v->>2)::numeric, (v->>3)::numeric, (v->>4)::numeric,
        0.01, 10, (v->>5)::currency_mode) a on true
      order by c.n`);

    const wrong: unknown[] = [];
    let above = 0;
    for (const { n, currency, special: now, normal } of rows) {
      const [priceUsd, priceZig, usd, zig, r, m] = cases[n - 1];
      const its = { priceUsd, priceZig };
      const typed = { priceUsd: usd, priceZig: zig };
      const pricing = { rate: r, usdStep: "0.01", zigStep: "10" };
      const was = { usd: effectiveUsd(its, pricing), zig: effectiveZig(its, pricing)?.amount ?? null };
      const is = { usd: specialUsd(its, typed, pricing), zig: specialZig(its, typed, pricing)?.amount ?? null };
      if (currency === null) {
        // Nothing the menu shows is above, unless rounding on a one-price item put it there.
        const onePrice = priceUsd === null || priceZig === null;
        const shown = (["usd", "zig"] as const).filter(
          (c) => m !== `${c === "usd" ? "zig" : "usd"}_only` || is[c === "usd" ? "zig" : "usd"] === null,
        );
        const up = shown.filter(
          (c) => is[c] !== null && was[c] !== null && Number(is[c]) > Number(was[c]),
        );
        const excused = up.every((c) => onePrice && (c === "usd" ? usd : zig) === null);
        if (!excused) wrong.push({ case: cases[n - 1], was, is });
        continue;
      }
      above += 1;
      const c = currency as "usd" | "zig";
      if (
        Number(is[c]) !== Number(now) ||
        Number(was[c]) !== Number(normal) ||
        Number(now) <= Number(normal)
      ) {
        wrong.push({ case: cases[n - 1], now, normal, was, is });
      }
    }
    expect(wrong).toEqual([]);
    expect(rows).toHaveLength(cases.length);
    expect(above).toBeGreaterThan(500);
  });
});

describe("two changes at once", () => {
  type Party = PoolClient & { pid: number };
  /** An owner's transaction as the app runs it. */
  async function party(): Promise<Party> {
    const client = await app.pool.connect();
    await client.query("begin");
    await client.query("select set_config('app.restaurant_id', $1, true)", [restaurantId]);
    const { rows } = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
    return Object.assign(client, { pid: rows[0].pid });
  }
  const isBlockedBy = (holder: number) =>
    vi.waitFor(
      async () => {
        const { rows } = await owner.db.execute(sql`
          select 1 from pg_stat_activity where ${holder} = any(pg_blocking_pids(pid)) and wait_event = 'advisory'`);
        expect(rows).not.toHaveLength(0);
      },
      { timeout: 10_000, interval: 20 },
    );

  type Write = (client: PoolClient, ids: { item: string; off: string }) => Promise<unknown>;
  const writes = {
    "a lower item price": (client, ids) =>
      client.query("update menu_items set price_usd = 7 where id = $1", [ids.item]),
    "a higher rate": (client) =>
      client.query("insert into exchange_rates (restaurant_id, usd_to_zig, set_by) values ($1, 40, $2)", [
        restaurantId,
        staffId,
      ]),
    "a new special": (client, ids) =>
      client.query("insert into specials (restaurant_id, menu_item_id, special_price_usd) values ($1, $2, 9)", [
        restaurantId,
        ids.item,
      ]),
    "a special turned on": (client, ids) =>
      client.query("update specials set active = true where id = $1", [ids.off]),
    "a mode that shows ZiG": (client) =>
      client.query("update restaurants set currency_mode = 'both' where id = $1", [restaurantId]),
  } satisfies Record<string, Write>;
  type Name = keyof typeof writes;

  // Each is fine alone, on $10 / ZiG 240 at 26.2 with a $9 special that is off; together they aren't.
  it.each([
    ["a lower item price", "a new special", "both"],
    ["a new special", "a lower item price", "both"],
    ["a lower item price", "a special turned on", "both"],
    ["a special turned on", "a lower item price", "both"],
    ["a higher rate", "a new special", "both"],
    ["a new special", "a higher rate", "both"],
    ["a higher rate", "a special turned on", "both"],
    ["a special turned on", "a higher rate", "both"],
    ["a mode that shows ZiG", "a new special", "usd_only"],
    ["a new special", "a mode that shows ZiG", "usd_only"],
  ] as [Name, Name, CurrencyMode][])(
    "%s commits first: %s waits for it and is refused",
    async (first, second, currencyMode) => {
      await mode(currencyMode);
      await rate("26.2");
      const itemId = await item("10", currencyMode === "usd_only" ? "200" : "240");
      const ids = { item: itemId, off: await special(itemId, { usd: "9" }, { active: false }) };
      const [one, two] = [await party(), await party()];
      try {
        await writes[first](one, ids);
        const waiting = outcome(writes[second](two, ids));
        await isBlockedBy(one.pid);
        await one.query("commit");
        expect(await waiting).toBe(RULE);
      } finally {
        one.release(true);
        two.release(true);
      }
    },
  );

  it("lets the second through when the first rolls back", async () => {
    const id = await item("10");
    const [one, two] = [await party(), await party()];
    try {
      await writes["a lower item price"](one, { item: id, off: "" });
      const waiting = outcome(writes["a new special"](two, { item: id, off: "" }));
      await isBlockedBy(one.pid);
      await one.query("rollback");
      expect(await waiting).toBe("saved");
      await two.query("rollback");
    } finally {
      one.release(true);
      two.release(true);
    }
  });
});
