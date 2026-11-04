import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog, categories, menuItems, restaurants, specials } from "@/db/schema";
import {
  openOwnerDatabase,
  testDatabaseSettings,
} from "../../test/integration/database";
import { archiveMenuItem, getMenu } from "./menu";
import { menuTag } from "./menu-cache";
import {
  createSpecial,
  FINISHED_SPECIALS_LISTED,
  listSpecials,
  type NewSpecial,
  setSpecialActive,
} from "./specials";

const revalidateTag = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidateTag }));

/**
 * Promotions against a real Postgres, as app_tenant, so everything here also
 * holds under RLS. The windows are the point: dates are the restaurant's, and
 * the instants they become are checked around midnight in Africa/Harare (UTC+2).
 */
const owner = openOwnerDatabase();
const created: string[] = [];

async function newRestaurant(timezone = "Africa/Harare") {
  const restaurantId = crypto.randomUUID();
  await owner.db.insert(restaurants).values({
    id: restaurantId,
    name: "Mama's Kitchen",
    slug: `specials-lib-${restaurantId}`,
    menuToken: `specials-lib-${restaurantId}`,
    currencyMode: "usd_only",
    timezone,
  });
  created.push(restaurantId);
  const [category] = await owner.db
    .insert(categories)
    .values({ restaurantId, name: "Mains" })
    .returning({ id: categories.id });
  return { restaurantId, categoryId: category.id };
}

const newItem = async (
  { restaurantId, categoryId }: { restaurantId: string; categoryId: string },
  name = "Beef stew",
) => {
  const [{ id }] = await owner.db
    .insert(menuItems)
    .values({ restaurantId, categoryId, name, priceUsd: "8" })
    .returning({ id: menuItems.id });
  return id;
};

const promotion = (menuItemId: string, fields: Partial<NewSpecial> = {}): NewSpecial => ({
  menuItemId,
  title: null,
  priceUsd: "6",
  priceZig: null,
  startDate: null,
  endDate: null,
  ...fields,
});

const rowsOf = (restaurantId: string) =>
  owner.db.select().from(specials).where(eq(specials.restaurantId, restaurantId));

const at = (iso: string) => new Date(iso);

/** The special the page would show for the item at `now`. */
const liveAt = async (tenant: { restaurantId: string }, now: Date) =>
  (await getMenu(tenant, now)).categories
    .flatMap((category) => category.items)
    .map(({ name, special }) => [name, special?.priceUsd ?? special?.title ?? null]);

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

describe("a date-only window becomes instants in the restaurant's timezone", () => {
  it("opens at local midnight on the start date and closes at local midnight after the end date", async () => {
    const tenant = await newRestaurant();
    const itemId = await newItem(tenant);

    expect(
      await createSpecial(tenant, promotion(itemId, { startDate: "2030-03-01", endDate: "2030-03-07" })),
    ).toBe("saved");

    const [row] = await rowsOf(tenant.restaurantId);
    // Harare is UTC+2: midnight on the 1st is 22:00 UTC on the 28th.
    expect(row.startsAt).toEqual(at("2030-02-28T22:00:00Z"));
    // An end date is inclusive: the window closes when the 8th begins.
    expect(row.endsAt).toEqual(at("2030-03-07T22:00:00Z"));
  });

  it("is live from the first second of the start date, and not the second before", async () => {
    const tenant = await newRestaurant();
    const itemId = await newItem(tenant);
    await createSpecial(tenant, promotion(itemId, { startDate: "2030-03-01", endDate: "2030-03-07" }));

    // 23:59:59 on 28 February in Harare, then 00:00:00 on 1 March.
    expect(await liveAt(tenant, at("2030-02-28T21:59:59Z"))).toEqual([["Beef stew", null]]);
    expect(await liveAt(tenant, at("2030-02-28T22:00:00Z"))).toEqual([["Beef stew", "6"]]);
  });

  it("is live through the whole of the end date, and over when the next day begins", async () => {
    const tenant = await newRestaurant();
    const itemId = await newItem(tenant);
    await createSpecial(tenant, promotion(itemId, { startDate: "2030-03-01", endDate: "2030-03-07" }));

    // 23:59:59 on 7 March in Harare, then 00:00:00 on 8 March.
    expect(await liveAt(tenant, at("2030-03-07T21:59:59Z"))).toEqual([["Beef stew", "6"]]);
    expect(await liveAt(tenant, at("2030-03-07T22:00:00Z"))).toEqual([["Beef stew", null]]);
  });

  it("does not use UTC's midnight: 23:30 UTC is already the next day in Harare", async () => {
    const tenant = await newRestaurant();
    const itemId = await newItem(tenant);
    await createSpecial(tenant, promotion(itemId, { startDate: "2030-03-01", endDate: "2030-03-01" }));

    expect(await liveAt(tenant, at("2030-02-28T23:30:00Z"))).toEqual([["Beef stew", "6"]]);
    // 01:00 UTC on 2 March is 03:00 in Harare: the day is over.
    expect(await liveAt(tenant, at("2030-03-01T22:30:00Z"))).toEqual([["Beef stew", null]]);
  });

  it("follows the restaurant's zone, not the server's: New York is UTC-5 here", async () => {
    const tenant = await newRestaurant("America/New_York");
    const itemId = await newItem(tenant);
    await createSpecial(tenant, promotion(itemId, { startDate: "2030-03-01", endDate: "2030-03-01" }));

    const [row] = await rowsOf(tenant.restaurantId);
    expect(row.startsAt).toEqual(at("2030-03-01T05:00:00Z"));
    expect(row.endsAt).toEqual(at("2030-03-02T05:00:00Z"));
  });

  it("closes at the next midnight on a clock-change day (23 hours long in New York)", async () => {
    const tenant = await newRestaurant("America/New_York");
    const itemId = await newItem(tenant);
    // US clocks go forward on 10 March 2030: the 10th is 23 hours long.
    await createSpecial(tenant, promotion(itemId, { startDate: "2030-03-10", endDate: "2030-03-10" }));

    const [row] = await rowsOf(tenant.restaurantId);
    expect(row.startsAt).toEqual(at("2030-03-10T05:00:00Z"));
    expect(row.endsAt).toEqual(at("2030-03-11T04:00:00Z"));
  });

  it("shows the dates back as typed", async () => {
    const tenant = await newRestaurant();
    const itemId = await newItem(tenant);
    await createSpecial(tenant, promotion(itemId, { startDate: "2030-03-01", endDate: "2030-03-07" }));

    expect(await listSpecials(tenant, at("2030-03-02T10:00:00Z"))).toMatchObject([
      { startDate: "2030-03-01", endDate: "2030-03-07", status: "live" },
    ]);
  });

  it("with no dates, is on from the moment it is saved and stays on until turned off", async () => {
    const tenant = await newRestaurant();
    const itemId = await newItem(tenant);
    const before = Date.now();
    await createSpecial(tenant, promotion(itemId));

    const [row] = await rowsOf(tenant.restaurantId);
    // Postgres's clock, so a minute either side of this one.
    expect(Math.abs(row.startsAt!.getTime() - before)).toBeLessThan(60_000);
    expect(row.endsAt).toBeNull();
    expect(await liveAt(tenant, new Date(row.startsAt!.getTime() - 1))).toEqual([["Beef stew", null]]);
    // A millisecond on: Postgres keeps microseconds, and a Date drops them.
    expect(await liveAt(tenant, new Date(row.startsAt!.getTime() + 1))).toEqual([["Beef stew", "6"]]);
    expect(await liveAt(tenant, at("2090-01-01T00:00:00Z"))).toEqual([["Beef stew", "6"]]);
  });

  it("with a blank start and an end date already gone, is refused: there is no window", async () => {
    const tenant = await newRestaurant();
    const itemId = await newItem(tenant);

    expect(await createSpecial(tenant, promotion(itemId, { endDate: "2020-01-07" }))).toBe("already_over");

    expect(await rowsOf(tenant.restaurantId)).toEqual([]);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("with a blank start, can end today: the window runs to tonight's midnight", async () => {
    const tenant = await newRestaurant();
    const itemId = await newItem(tenant);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Harare" }).format(new Date());

    expect(await createSpecial(tenant, promotion(itemId, { endDate: today }))).toBe("saved");
  });

  it("with only an end date, runs until the end of that day", async () => {
    const tenant = await newRestaurant();
    const itemId = await newItem(tenant);
    await createSpecial(tenant, promotion(itemId, { endDate: "2030-03-07" }));

    expect(await liveAt(tenant, at("2030-03-07T21:59:59Z"))).toEqual([["Beef stew", "6"]]);
    expect(await liveAt(tenant, at("2030-03-07T22:00:00Z"))).toEqual([["Beef stew", null]]);
  });

  it("with only a start date, runs from that day until turned off", async () => {
    const tenant = await newRestaurant();
    const itemId = await newItem(tenant);
    await createSpecial(tenant, promotion(itemId, { startDate: "2030-03-01" }));

    expect(await liveAt(tenant, at("2030-02-28T21:59:59Z"))).toEqual([["Beef stew", null]]);
    expect(await liveAt(tenant, at("2090-01-01T00:00:00Z"))).toEqual([["Beef stew", "6"]]);
  });

  it("shows the normal price afterwards with no one undoing anything", async () => {
    const tenant = await newRestaurant();
    const itemId = await newItem(tenant);
    await createSpecial(tenant, promotion(itemId, { startDate: "2030-03-01", endDate: "2030-03-01" }));

    const before = await rowsOf(tenant.restaurantId);
    expect(await liveAt(tenant, at("2030-03-05T00:00:00Z"))).toEqual([["Beef stew", null]]);
    // The row is still active: the window alone ended it.
    expect(before.map(({ active }) => active)).toEqual([true]);
    const [{ priceUsd }] = (await getMenu(tenant)).categories[0].items;
    expect(priceUsd).toBe("8");
  });

  it("a special that starts within 5 minutes shows once the page is rendered after it", async () => {
    const tenant = await newRestaurant();
    const itemId = await newItem(tenant);
    await createSpecial(tenant, promotion(itemId, { startDate: "2030-03-01" }));
    const opens = at("2030-02-28T22:00:00Z");

    // A page rendered 4 minutes before is up to 5 minutes old at the opening,
    // and the next render is at most 5 minutes after that.
    expect(await liveAt(tenant, new Date(opens.getTime() - 4 * 60_000))).toEqual([["Beef stew", null]]);
    expect(await liveAt(tenant, new Date(opens.getTime() + 60_000))).toEqual([["Beef stew", "6"]]);
  });
});

describe("D-05, as the app answers it", () => {
  it("a special that is over doesn't block a new one with a blank start", async () => {
    const tenant = await newRestaurant();
    const itemId = await newItem(tenant);
    await createSpecial(tenant, promotion(itemId, { startDate: "2020-01-01", endDate: "2020-01-07" }));

    expect(await createSpecial(tenant, promotion(itemId))).toBe("saved");

    // The old one stays active: nobody has to turn off a special that is over.
    expect((await rowsOf(tenant.restaurantId)).map(({ active }) => active)).toEqual([true, true]);
  });

  it("a blank start still overlaps a special that is on now", async () => {
    const tenant = await newRestaurant();
    const itemId = await newItem(tenant);
    await createSpecial(tenant, promotion(itemId, { startDate: "2020-01-01", endDate: "2099-12-31" }));

    expect(await createSpecial(tenant, promotion(itemId))).toBe("overlap");
  });

  it("answers 'overlap' for a second active special in the same dates, and adds nothing", async () => {
    const tenant = await newRestaurant();
    const itemId = await newItem(tenant);
    await createSpecial(tenant, promotion(itemId, { startDate: "2030-03-01", endDate: "2030-03-07" }));
    revalidateTag.mockClear();

    expect(
      await createSpecial(tenant, promotion(itemId, { startDate: "2030-03-07", endDate: "2030-03-09" })),
    ).toBe("overlap");

    expect(await rowsOf(tenant.restaurantId)).toHaveLength(1);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("takes the day after: the end date's day is the first one's last", async () => {
    const tenant = await newRestaurant();
    const itemId = await newItem(tenant);
    await createSpecial(tenant, promotion(itemId, { startDate: "2030-03-01", endDate: "2030-03-07" }));

    expect(
      await createSpecial(tenant, promotion(itemId, { startDate: "2030-03-08", endDate: "2030-03-09" })),
    ).toBe("saved");
  });

  it("answers 'overlap' for turning an overlapping one back on", async () => {
    const tenant = await newRestaurant();
    const itemId = await newItem(tenant);
    await createSpecial(tenant, promotion(itemId, { startDate: "2030-03-01", endDate: "2030-03-07" }));
    const [first] = await rowsOf(tenant.restaurantId);
    expect(await setSpecialActive(tenant, first.id, false)).toBe("saved");
    expect(
      await createSpecial(tenant, promotion(itemId, { startDate: "2030-03-03", endDate: "2030-03-04" })),
    ).toBe("saved");

    expect(await setSpecialActive(tenant, first.id, true)).toBe("overlap");
    expect((await rowsOf(tenant.restaurantId)).find(({ id }) => id === first.id)?.active).toBe(false);
  });

  it("an item with no end date blocks every later special until it is turned off", async () => {
    const tenant = await newRestaurant();
    const itemId = await newItem(tenant);
    await createSpecial(tenant, promotion(itemId));

    expect(await createSpecial(tenant, promotion(itemId, { startDate: "2040-01-01", endDate: "2040-01-02" }))).toBe("overlap");
    const [open] = await rowsOf(tenant.restaurantId);
    await setSpecialActive(tenant, open.id, false);
    expect(await createSpecial(tenant, promotion(itemId, { startDate: "2040-01-01", endDate: "2040-01-02" }))).toBe("saved");
  });

  it("is per item", async () => {
    const tenant = await newRestaurant();
    const stew = await newItem(tenant);
    const pie = await newItem(tenant, "Pie");

    expect(await createSpecial(tenant, promotion(stew))).toBe("saved");
    expect(await createSpecial(tenant, promotion(pie))).toBe("saved");
  });
});

describe("saving a special refreshes the public page", () => {
  it("revalidates this restaurant's menu after a create", async () => {
    const tenant = await newRestaurant();
    const itemId = await newItem(tenant);

    expect(await createSpecial(tenant, promotion(itemId))).toBe("saved");

    expect(revalidateTag).toHaveBeenCalledExactlyOnceWith(menuTag(tenant.restaurantId), { expire: 0 });
  });
});

describe("the owner's list stays a bounded read", () => {
  const listedNow = at("2030-06-01T00:00:00Z");
  const day = (n: number) => new Date(Date.UTC(2020, 0, n));

  /** Rows no form could leave this many of in a test's time. */
  const finished = (
    { restaurantId }: { restaurantId: string },
    menuItemId: string,
    count: number,
    fields: (n: number) => Partial<typeof specials.$inferInsert>,
  ) =>
    owner.db.insert(specials).values(
      Array.from({ length: count }, (_, index) => ({
        restaurantId,
        menuItemId,
        specialPriceUsd: "6",
        ...fields(index + 1),
      })),
    );

  it("keeps only the most recent that are over, and every one still to come", async () => {
    const tenant = await newRestaurant();
    const pie = await newItem(tenant, "Apple pie");
    const stew = await newItem(tenant, "Beef stew");
    const tea = await newItem(tenant, "Tea");
    await finished(tenant, pie, FINISHED_SPECIALS_LISTED + 5, (n) => ({
      title: `Week ${n}`,
      startsAt: day(n),
      endsAt: day(n + 1),
    }));
    await createSpecial(tenant, promotion(stew, { startDate: "2030-05-01" }));
    await createSpecial(tenant, promotion(tea, { startDate: "2030-07-01" }));

    const listed = await listSpecials(tenant, listedNow);

    expect(listed.filter(({ status }) => status === "live")).toHaveLength(1);
    expect(listed.filter(({ status }) => status === "scheduled")).toHaveLength(1);
    const over = listed.filter(({ status }) => status === "ended").map(({ title }) => title);
    expect(over).toHaveLength(FINISHED_SPECIALS_LISTED);
    expect(over).toContain(`Week ${FINISHED_SPECIALS_LISTED + 5}`);
    expect(over).not.toContain("Week 5");
  });

  it("counts turned-off specials in the same limit as those that are over", async () => {
    const tenant = await newRestaurant();
    const pie = await newItem(tenant, "Apple pie");
    await finished(tenant, pie, FINISHED_SPECIALS_LISTED, (n) => ({
      title: `Off ${n}`,
      active: false,
      startsAt: day(n),
      endsAt: null,
    }));
    await finished(tenant, pie, 5, (n) => ({
      title: `Over ${n}`,
      startsAt: new Date(Date.UTC(2021, 0, n)),
      endsAt: new Date(Date.UTC(2021, 0, n + 1)),
    }));

    const listed = await listSpecials(tenant, listedNow);

    expect(listed).toHaveLength(FINISHED_SPECIALS_LISTED);
    // Later than any of the turned-off ones, so all five stay in.
    expect(listed.filter(({ status }) => status === "ended")).toHaveLength(5);
    expect(listed.map(({ title }) => title)).not.toContain("Off 1");
  });

  it("keeps a turned-off special whose dates are still to come ahead of old ones", async () => {
    const tenant = await newRestaurant();
    const pie = await newItem(tenant, "Apple pie");
    await finished(tenant, pie, FINISHED_SPECIALS_LISTED, (n) => ({
      startsAt: day(n),
      endsAt: day(n + 1),
    }));
    await finished(tenant, pie, 1, () => ({
      title: "Saved for later",
      active: false,
      startsAt: at("2031-01-01T00:00:00Z"),
      endsAt: at("2031-02-01T00:00:00Z"),
    }));

    expect((await listSpecials(tenant, listedNow)).map(({ title }) => title)).toContain("Saved for later");
  });

  it("doesn't spend the limit on specials of archived items", async () => {
    const tenant = await newRestaurant();
    const pie = await newItem(tenant, "Apple pie");
    const stew = await newItem(tenant, "Beef stew");
    await finished(tenant, pie, 1, () => ({ title: "Old", startsAt: day(1), endsAt: day(2) }));
    await finished(tenant, stew, FINISHED_SPECIALS_LISTED, (n) => ({
      startsAt: new Date(Date.UTC(2021, 0, n)),
      endsAt: new Date(Date.UTC(2021, 0, n + 1)),
    }));
    await archiveMenuItem(tenant, stew);

    expect((await listSpecials(tenant, listedNow)).map(({ title }) => title)).toEqual(["Old"]);
  });
});

describe("turning a special on and off", () => {
  it("off takes it off the page at once, on puts it back", async () => {
    const tenant = await newRestaurant();
    const itemId = await newItem(tenant);
    await createSpecial(tenant, promotion(itemId));
    const [{ id }] = await rowsOf(tenant.restaurantId);
    revalidateTag.mockClear();

    expect(await setSpecialActive(tenant, id, false)).toBe("saved");
    expect(await liveAt(tenant, new Date())).toEqual([["Beef stew", null]]);
    expect(revalidateTag).toHaveBeenCalledWith(menuTag(tenant.restaurantId), { expire: 0 });

    expect(await setSpecialActive(tenant, id, true)).toBe("saved");
    expect(await liveAt(tenant, new Date())).toEqual([["Beef stew", "6"]]);
  });

  it("lists it with its state, live ones first", async () => {
    const tenant = await newRestaurant();
    const stew = await newItem(tenant, "Beef stew");
    const pie = await newItem(tenant, "Apple pie");
    const tea = await newItem(tenant, "Tea");
    await createSpecial(tenant, promotion(stew, { startDate: "2030-03-01", endDate: "2030-03-07" }));
    await createSpecial(tenant, promotion(pie, { startDate: "2030-04-01" }));
    await createSpecial(tenant, promotion(tea, { title: "Chai", priceUsd: null }));
    const [teaSpecial] = (await rowsOf(tenant.restaurantId)).filter((row) => row.menuItemId === tea);
    await setSpecialActive(tenant, teaSpecial.id, false);

    const listed = await listSpecials(tenant, at("2030-03-02T10:00:00Z"));

    expect(listed.map(({ itemName, status }) => [itemName, status])).toEqual([
      ["Beef stew", "live"],
      ["Apple pie", "scheduled"],
      ["Tea", "off"],
    ]);
    expect(listed[2]).toMatchObject({ title: "Chai", priceUsd: null });
    expect(await listSpecials(tenant, at("2030-06-01T00:00:00Z"))).toMatchObject([
      { itemName: "Apple pie", status: "live" },
      { itemName: "Tea", status: "off" },
      { itemName: "Beef stew", status: "ended" },
    ]);
  });

  it("answers not_found for an unknown or malformed id", async () => {
    const tenant = await newRestaurant();
    expect(await setSpecialActive(tenant, crypto.randomUUID(), false)).toBe("not_found");
    expect(await setSpecialActive(tenant, "not-a-uuid", false)).toBe("not_found");
  });
});

describe("another restaurant's ids", () => {
  it("can't put a special on another restaurant's item, or switch one", async () => {
    const mine = await newRestaurant();
    const theirs = await newRestaurant();
    const theirItem = await newItem(theirs);
    await createSpecial(theirs, promotion(theirItem));
    const [theirSpecial] = await rowsOf(theirs.restaurantId);

    expect(await createSpecial(mine, promotion(theirItem, { startDate: "2031-01-01" }))).toBe("no_such_item");
    expect(await setSpecialActive(mine, theirSpecial.id, false)).toBe("not_found");

    expect(await rowsOf(mine.restaurantId)).toEqual([]);
    expect((await rowsOf(theirs.restaurantId)).map(({ active }) => active)).toEqual([true]);
    expect(await listSpecials(mine)).toEqual([]);
  });
});

describe("an item that is archived, or has no price to compare with", () => {
  it("an archived item can't be given a special", async () => {
    const tenant = await newRestaurant();
    const itemId = await newItem(tenant);
    await archiveMenuItem(tenant, itemId);

    expect(await createSpecial(tenant, promotion(itemId))).toBe("no_such_item");
  });

  it("a special on an item archived later shows nowhere, and can't be switched", async () => {
    const tenant = await newRestaurant();
    const itemId = await newItem(tenant);
    await createSpecial(tenant, promotion(itemId));
    const [{ id }] = await rowsOf(tenant.restaurantId);

    await archiveMenuItem(tenant, itemId);

    expect(await liveAt(tenant, new Date())).toEqual([]);
    expect(await listSpecials(tenant)).toEqual([]);
    expect(await setSpecialActive(tenant, id, false)).toBe("not_found");
    // The row stays: nothing customer-facing is deleted.
    expect(await rowsOf(tenant.restaurantId)).toHaveLength(1);
  });

  it("a special whose item loses its USD price still resolves, from the special's own", async () => {
    const tenant = await newRestaurant();
    const itemId = await newItem(tenant);
    await createSpecial(tenant, promotion(itemId, { priceUsd: "6" }));
    await owner.db
      .update(menuItems)
      .set({ priceUsd: null, priceZig: "210" })
      .where(eq(menuItems.id, itemId));

    const [item] = (await getMenu(tenant)).categories[0].items;

    expect(item).toMatchObject({
      priceUsd: null,
      priceZig: "210",
      special: { priceUsd: "6", priceZig: null },
    });
  });
});

describe("audit", () => {
  it("records nothing for an owner, as the rest of the menu does", async () => {
    const tenant = await newRestaurant();
    const itemId = await newItem(tenant);
    await createSpecial(tenant, promotion(itemId));

    expect(
      await owner.db.select().from(auditLog).where(eq(auditLog.restaurantId, tenant.restaurantId)),
    ).toEqual([]);
  });
});
