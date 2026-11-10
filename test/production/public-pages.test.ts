import { eq } from "drizzle-orm";
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  categories,
  bookings,
  diningTables,
  menuItems,
  restaurants,
  servicePeriods,
  staff,
  staffAuthRateLimit,
} from "../../src/db/schema";
import { addDays, localToday } from "../../src/lib/booking-engine";
import { aBooking, bookableRestaurant, bookingsOf } from "../integration/bookings";
import {
  openOwnerDatabase,
  testDatabaseSettings,
} from "../integration/database";

/**
 * The public pages' cache, on a real production build: `use cache`, ISR and the
 * proxy do nothing under `vitest`, so this is the only place they run. Needs
 * `npm run build` first, and the integration tests' Postgres. Run it with
 * `npm run test:production`.
 *
 * It starts `next start` with NODE_ENV=test, because env validation refuses
 * NEON_WS_PROXY under production; the bundle is still the production build. No
 * Vercel here: this is Next.js's own cache, not the edge in front of it.
 *
 * Every test takes a restaurant of its own, so its first visit is a real miss
 * however many times this has run against the same build. Those restaurants
 * stay behind, because the last-owner trigger won't let their owners go.
 */
/** A new public page goes here, and in `publicPagePrefixes` in src/proxy.ts. */
type Restaurant = { menuToken: string; qrToken: string };
const publicPages = [
  {
    route: "/m/[menuToken]",
    tokenOf: (restaurant: Restaurant) => restaurant.menuToken,
    url: (token: string) => `/m/${token}`,
    unknown: "Menu not found",
  },
  {
    route: "/t/[qrToken]",
    tokenOf: (restaurant: Restaurant) => restaurant.qrToken,
    url: (token: string) => `/t/${token}`,
    unknown: "This code is out of date",
  },
];

const refusedMethods = ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "PROPFIND"];

const owner = openOwnerDatabase();
let server: ChildProcess;
let origin: string;
let serverOutput = "";

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolve((address as { port: number }).port));
    });
  });

async function waitFor<T>(what: string, attempt: () => Promise<T | undefined>) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`next start exited early:\n${serverOutput}`);
    }
    const result = await attempt().catch(() => undefined);
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${what}:\n${serverOutput}`);
}

beforeAll(async () => {
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  server = spawn(
    "node_modules/.bin/next",
    ["start", "-H", "127.0.0.1", "-p", String(port)],
    {
      env: {
        ...process.env,
        NODE_ENV: "test",
        DATABASE_URL: testDatabaseSettings().connectionString,
        NEXT_PUBLIC_APP_URL: origin,
        AUTH_SECRET: "a-stand-in-of-at-least-32-characters",
        // Blank, so the sign-in link goes to the console for us to read.
        RESEND_API_KEY: "",
      },
    },
  );
  server.stdout?.on("data", (chunk) => (serverOutput += chunk));
  server.stderr?.on("data", (chunk) => (serverOutput += chunk));
  await waitFor("the server", async () => (await fetch(`${origin}/login`)).ok || undefined);
});

afterAll(async () => {
  server?.kill();
  await owner.pool.end();
});

async function newRestaurant(dish: string, currencyMode: "usd_only" | "zig_only" = "usd_only") {
  const id = crypto.randomUUID();
  const menuToken = `production-${id}`;
  await owner.db.insert(restaurants).values({
    id,
    name: `Restaurant ${id}`,
    slug: menuToken,
    menuToken,
    currencyMode,
  });
  const categoryId = crypto.randomUUID();
  await owner.db.insert(categories).values({ id: categoryId, restaurantId: id, name: "Mains" });
  await owner.db
    .insert(menuItems)
    .values({ restaurantId: id, categoryId, name: dish, priceUsd: "8" });
  // 22 base62 characters, and unique to this restaurant.
  const qrToken = id.replaceAll("-", "").slice(0, 22).padEnd(22, "0");
  const tableId = crypto.randomUUID();
  await owner.db
    .insert(diningTables)
    .values({ id: tableId, restaurantId: id, label: "7", capacity: 4, qrToken });
  return { id, menuToken, qrToken, categoryId, tableId };
}

const visit = (path: string, init?: RequestInit) =>
  fetch(`${origin}${path}`, { redirect: "manual", ...init });

const cacheStatus = (response: Response) => response.headers.get("x-nextjs-cache");

/** A real owner session: the dev bypass is compiled out of this build. */
async function signInAsOwnerOf(restaurantId: string) {
  const email = `${restaurantId}@production.example.test`;
  await owner.db.insert(staff).values({
    restaurantId,
    email,
    displayName: "Owner",
    role: "owner",
  });
  // Rate limited per address, and kept in the database: back to back runs and
  // sign-ins in this file would otherwise trip it.
  await owner.db.delete(staffAuthRateLimit);
  await fetch(`${origin}/api/auth/staff/sign-in/magic-link`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ email, callbackURL: "/dashboard", errorCallbackURL: "/login" }),
  });
  const link = await waitFor("the sign-in email", async () => {
    const [, sent] =
      serverOutput.match(new RegExp(`Email to ${email}[\\s\\S]*?(http\\S+verify\\S+)`)) ?? [];
    return sent;
  });
  const signedIn = await fetch(link, { redirect: "manual" });
  return signedIn.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

describe("the build", () => {
  it.each(publicPages)("caches $route like a prerendered page", ({ route }) => {
    const manifest = JSON.parse(readFileSync(".next/prerender-manifest.json", "utf8"));
    expect(Object.keys(manifest.dynamicRoutes)).toContain(route);
  });
});

describe.each(publicPages)("$route", ({ tokenOf, url, unknown }) => {
  it("is rendered once, then served from the cache", async () => {
    const restaurant = await newRestaurant("Stew");

    const first = await visit(url(tokenOf(restaurant)));
    const second = await visit(url(tokenOf(restaurant)));

    expect([first.status, cacheStatus(first)]).toEqual([200, "MISS"]);
    expect([second.status, cacheStatus(second)]).toEqual([200, "HIT"]);
    expect(await second.text()).toContain("Stew");
  });

  it("can be cached for five minutes at most, so a special's window is never far out", async () => {
    const restaurant = await newRestaurant("Stew");

    const response = await visit(url(tokenOf(restaurant)));

    expect(response.headers.get("cache-control")).toBe("s-maxage=300");
  });

  it.each(refusedMethods)("refuses %s, which can't take the page down", async (method) => {
    const restaurant = await newRestaurant("Stew");

    const attack = await visit(url(tokenOf(restaurant)), { method });
    const customer = await visit(url(tokenOf(restaurant)));

    expect(attack.status).toBe(405);
    expect(attack.headers.get("allow")).toBe("GET, HEAD");
    expect(customer.status).toBe(200);
    expect(await customer.text()).toContain("Stew");
  });

  it("answers HEAD without emptying the page for the next visit", async () => {
    const restaurant = await newRestaurant("Stew");

    const head = await visit(url(tokenOf(restaurant)), { method: "HEAD" });
    const customer = await visit(url(tokenOf(restaurant)));

    expect(head.status).toBe(200);
    expect(customer.status).toBe(200);
    expect(await customer.text()).toContain("Stew");
  });

  it("is a real 404 for an unknown token, first and second visit", async () => {
    const token = `no-such-token-${crypto.randomUUID()}`;

    const first = await visit(url(token));
    const second = await visit(url(token));

    expect(first.status).toBe(404);
    expect(second.status).toBe(404);
    expect(await second.text()).toContain(unknown);
  });

  it("a save refreshes that restaurant's page and leaves another's in the cache", async () => {
    const mine = await newRestaurant("Stew");
    const theirs = await newRestaurant("Curry");
    await visit(url(tokenOf(mine)));
    await visit(url(tokenOf(theirs)));
    const cookie = await signInAsOwnerOf(mine.id);

    const saved = await visit("/api/menu/items", {
      method: "POST",
      headers: { origin, cookie },
      body: new URLSearchParams({
        name: "Sadza",
        description: "",
        priceUsd: "4",
        categoryId: mine.categoryId,
      }),
    });

    expect(saved.status).toBe(303);
    const refreshed = await visit(url(tokenOf(mine)));
    expect(cacheStatus(refreshed)).toBe("MISS");
    expect(await refreshed.text()).toContain("Sadza");
    expect(cacheStatus(await visit(url(tokenOf(theirs))))).toBe("HIT");
  });

  it("changing the exchange rate reprices the calculated ZiG prices on the next visit", async () => {
    const mine = await newRestaurant("Stew", "zig_only");
    const cookie = await signInAsOwnerOf(mine.id);
    const setRate = (usdToZig: string) =>
      visit("/api/menu/exchange-rate", {
        method: "POST",
        headers: { origin, cookie },
        body: new URLSearchParams({ usdToZig }),
      });
    expect((await setRate("26.2")).status).toBe(303);
    expect(await (await visit(url(tokenOf(mine)))).text()).toContain("ZiG 210");
    expect(cacheStatus(await visit(url(tokenOf(mine))))).toBe("HIT");

    expect((await setRate("30")).status).toBe(303);

    const repriced = await visit(url(tokenOf(mine)));
    expect(cacheStatus(repriced)).toBe("MISS");
    const body = await repriced.text();
    expect(body).toContain("ZiG 240");
    expect(body).not.toContain("ZiG 210");
  });
});

/**
 * Not one of `publicPages` above: a list of free tables must never come from a
 * cache, so this page's rule is the opposite of theirs.
 */
describe("the booking page", () => {
  const date = () => addDays(localToday(new Date(), "Africa/Harare"), 1);
  const timesPage = (slug: string) => `${origin}/r/${slug}/book?party=2&date=${date()}`;

  const book = (slug: string) => {
    const body = new FormData();
    for (const [key, value] of Object.entries({
      party: "2",
      date: date(),
      time: "19:00",
      name: "Production guest",
      phone: "0771234567",
      consent: "on",
    })) {
      body.set(key, value);
    }
    // An address of its own: the rate limit's count outlives this run, in the
    // database, so a second run inside ten minutes would otherwise spend the first's.
    const address = crypto.getRandomValues(new Uint8Array(3)).join(".");
    return fetch(`${origin}/api/r/${slug}/book`, {
      method: "POST",
      headers: { "x-forwarded-for": `10.${address}` },
      body,
    });
  };

  // An App Router page sends its prerendered shell, and so its 200, before the
  // slug can be looked up. This is the status that says so: spec 04 records it.
  it.each(["no-such-restaurant", "a%00b"])(
    "gives the friendly not-found page, out of search engines, for the slug %s",
    async (slug) => {
      const response = await fetch(`${origin}/r/${slug}/book`);
      expect(response.status).toBe(200);
      const page = await response.text();
      expect(page).toContain("Restaurant not found");
      expect(page).toContain('name="robots" content="noindex"');
    },
  );

  it("is a page, not an error, while online booking is off", async () => {
    const { slug } = await bookableRestaurant(owner.db, { rules: { enabled: false } });
    const response = await fetch(`${origin}/r/${slug}/book`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("isn&#x27;t available right now");
  });

  it("shows a time until it's booked, and not one visit longer", async () => {
    const { slug } = await bookableRestaurant(owner.db);
    expect(await (await fetch(timesPage(slug))).text()).toContain("time=19:00");

    expect((await book(slug)).status).toBe(201);

    expect(await (await fetch(timesPage(slug))).text()).not.toContain("time=19:00");
  });

  it("can't be taken down by a post to the page", async () => {
    const { slug } = await bookableRestaurant(owner.db);
    await fetch(timesPage(slug), { method: "POST" });

    const response = await fetch(timesPage(slug));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("time=19:00");
  });

  it("confirms over real HTTP, refuses the second, and logs neither guest", async () => {
    const { slug, restaurantId } = await bookableRestaurant(owner.db);

    const first = await book(slug);
    const second = await book(slug);

    expect(first.status).toBe(201);
    const { confirmation } = await first.json();
    expect(second.status).toBe(409);
    expect((await second.json()).error).toContain("just booked");
    const [booked] = await bookingsOf(owner.db, restaurantId);
    expect(booked.guestPhone).toBe("+263771234567");
    expect(serverOutput).not.toContain("771234567");
    expect(serverOutput).not.toContain(confirmation.manageToken);
  });

  it("doesn't reach the database from Next.js's prerender of a new path", async () => {
    const { slug } = await bookableRestaurant(owner.db);
    await fetch(`${origin}/r/${slug}/book`);
    // Next.js prerenders a newly seen path after answering it.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(serverOutput).not.toContain('Route "/r/[slug]/book"');
  });

  it("refuses a post from another site", async () => {
    const { slug } = await bookableRestaurant(owner.db);
    const response = await fetch(`${origin}/api/r/${slug}/book`, {
      method: "POST",
      headers: { origin: "https://elsewhere.example" },
      body: new FormData(),
    });
    expect(response.status).toBe(403);
  });
});

/**
 * A guest's manage link holds a bearer secret in its URL: nothing may store the
 * page, nothing may pass the URL on, and only a POST may cancel.
 */
describe("the manage page", () => {
  const MINUTE = 60_000;
  async function booked(startsInMinutes = 300) {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db);
    const row = aBooking(
      restaurantId,
      tableIds[0],
      new Date(Date.now() + startsInMinutes * MINUTE).toISOString(),
      new Date(Date.now() + (startsInMinutes + 90) * MINUTE).toISOString(),
    );
    await owner.db.insert(bookings).values(row);
    return { restaurantId, token: row.manageToken };
  }
  const statusIn = async (restaurantId: string) =>
    (await bookingsOf(owner.db, restaurantId))[0].status;

  it("is never stored by a cache, and never reaches another site in a Referer", async () => {
    const { token } = await booked();

    for (const response of [await visit(`/b/${token}`), await visit(`/b/${token}`)]) {
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("referrer-policy")).toBe("same-origin");
      expect(response.headers.get("x-nextjs-cache")).not.toBe("HIT");
      expect(response.headers.get("x-robots-tag")).toContain("noindex");
    }
  });

  it("shows the booking as it is now, not as it was on the last visit", async () => {
    const { restaurantId, token } = await booked();
    expect(await (await visit(`/b/${token}`)).text()).toContain("Cancel booking");

    await owner.db
      .update(bookings)
      .set({ status: "seated" })
      .where(eq(bookings.restaurantId, restaurantId));

    const after = await (await visit(`/b/${token}`)).text();
    expect(after).not.toContain("Cancel booking");
    expect(after).toContain("seated");
  });

  it("is a real 404, still with its headers, for an unknown token and a NUL", async () => {
    for (const token of [`no-such-token-${crypto.randomUUID()}`, "a%00b"]) {
      const response = await visit(`/b/${token}`);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("referrer-policy")).toBe("same-origin");
    }
  });

  it("is only read by a GET, so a link preview or a prefetch can't cancel", async () => {
    const { restaurantId, token } = await booked();

    await visit(`/b/${token}`);
    await visit(`/b/${token}`, { method: "HEAD" });
    await visit(`/b/${token}?cancel=1&_method=POST`);

    expect(await statusIn(restaurantId)).toBe("confirmed");
  });

  it("cancels on a POST, says so the second time too, and caches neither", async () => {
    const { restaurantId, token } = await booked();

    const first = await visit(`/b/${token}`, { method: "POST" });
    const second = await visit(`/b/${token}`, { method: "POST" });

    expect(first.status).toBe(200);
    expect(await first.text()).toContain("Your booking is cancelled.");
    expect(second.status).toBe(200);
    expect(await second.text()).toContain("This booking was already cancelled.");
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(await statusIn(restaurantId)).toBe("cancelled");
    expect(await (await visit(`/b/${token}`)).text()).toContain("cancelled");
  });

  it("takes the cancel a browser sends from the page, naming its own origin", async () => {
    const { restaurantId, token } = await booked();

    const response = await visit(`/b/${token}`, { method: "POST", headers: { origin } });

    expect(response.status).toBe(200);
    expect(await statusIn(restaurantId)).toBe("cancelled");
  });

  it.each(["https://elsewhere.example", "null"])(
    "refuses a cancel from Origin %s",
    async (from) => {
      const { restaurantId, token } = await booked();

      const response = await visit(`/b/${token}`, { method: "POST", headers: { origin: from } });

      expect(response.status).toBe(403);
      expect(await statusIn(restaurantId)).toBe("confirmed");
    },
  );

  it("refuses a cancel inside the cutoff, on the server's own clock", async () => {
    const { restaurantId, token } = await booked(60);

    const response = await visit(`/b/${token}`, { method: "POST", headers: { "x-now": "2000-01-01" } });

    expect(response.status).toBe(409);
    expect(await response.text()).toContain("Too late to cancel online — please call.");
    expect(await statusIn(restaurantId)).toBe("confirmed");
  });

  it("holds no manage token in the server's output", async () => {
    const { token } = await booked();
    await visit(`/b/${token}`, { method: "POST" });
    expect(serverOutput).not.toContain(token);
  });
});

describe("archiving a table", () => {
  it("stops its printed code working at once, not when the cached page expires", async () => {
    const restaurant = await newRestaurant("Stew");
    const cookie = await signInAsOwnerOf(restaurant.id);
    const [{ id: tableId }] = await owner.db
      .select({ id: diningTables.id })
      .from(diningTables)
      .where(eq(diningTables.restaurantId, restaurant.id));
    const scan = () => visit(`/t/${restaurant.qrToken}`);
    await scan();
    expect([(await scan()).status, cacheStatus(await scan())]).toEqual([200, "HIT"]);

    const archived = await visit(`/api/tables/${tableId}/archive`, {
      method: "POST",
      headers: { origin, cookie },
    });

    expect(archived.status).toBe(303);
    const after = await scan();
    expect(after.status).toBe(404);
    expect(await after.text()).toContain("This code is out of date");
  });

  it("leaves another restaurant's cached page where it was", async () => {
    const mine = await newRestaurant("Stew");
    const theirs = await newRestaurant("Curry");
    await visit(`/t/${theirs.qrToken}`);
    const cookie = await signInAsOwnerOf(mine.id);
    const [{ id: tableId }] = await owner.db
      .select({ id: diningTables.id })
      .from(diningTables)
      .where(eq(diningTables.restaurantId, mine.id));

    await visit(`/api/tables/${tableId}/archive`, { method: "POST", headers: { origin, cookie } });

    expect(cacheStatus(await visit(`/t/${theirs.qrToken}`))).toBe("HIT");
  });
});

describe("Book again on a table's page", () => {
  /** What the gate asks for, so that turning booking on can succeed. */
  async function readyForBooking(restaurantId: string) {
    await owner.db
      .update(restaurants)
      .set({ contactPhone: "+263771234567" })
      .where(eq(restaurants.id, restaurantId));
    await owner.db.insert(servicePeriods).values({
      restaurantId,
      name: "Lunch",
      weekday: 1,
      opensAt: "12:00",
      lastBookingAt: "14:00",
      closesAt: "15:00",
    });
  }

  const setBooking = (restaurant: { cookie: string }, enabled: boolean) =>
    visit("/api/bookings/settings/enabled", {
      method: "POST",
      headers: { origin, cookie: restaurant.cookie },
      body: new URLSearchParams({ enabled: String(enabled) }),
    });

  it("appears at once when booking is turned on, and goes at once when it's turned off", async () => {
    const restaurant = await newRestaurant("Stew");
    const cookie = await signInAsOwnerOf(restaurant.id);
    await readyForBooking(restaurant.id);
    const scan = () => visit(`/t/${restaurant.qrToken}`);
    const bookAgain = `href="/r/${restaurant.menuToken}/book"`;
    expect(await (await scan()).text()).not.toContain("Book again");
    expect(cacheStatus(await scan())).toBe("HIT");

    const on = await setBooking({ cookie }, true);
    expect(on.status).toBe(303);
    const whileOn = await scan();
    expect(cacheStatus(whileOn)).toBe("MISS");
    expect(await whileOn.text()).toContain(bookAgain);

    const off = await setBooking({ cookie }, false);
    expect(off.status).toBe(303);
    const whileOff = await scan();
    expect(cacheStatus(whileOff)).toBe("MISS");
    expect(await whileOff.text()).not.toContain("Book again");
  });

  it("leaves another restaurant's cached table page where it was", async () => {
    const mine = await newRestaurant("Stew");
    const theirs = await newRestaurant("Curry");
    await visit(`/t/${theirs.qrToken}`);
    const cookie = await signInAsOwnerOf(mine.id);
    await readyForBooking(mine.id);

    expect((await setBooking({ cookie }, true)).status).toBe(303);

    expect(cacheStatus(await visit(`/t/${theirs.qrToken}`))).toBe("HIT");
  });
});

describe("regenerating a table's token", () => {
  const regenerate = (restaurant: { tableId: string }, cookie: string) =>
    visit(`/api/tables/${restaurant.tableId}/regenerate`, {
      method: "POST",
      headers: { origin, cookie },
    });

  const tokenNow = async (tableId: string) =>
    (await owner.db.select().from(diningTables).where(eq(diningTables.id, tableId)))[0].qrToken;

  it("stops the old code at once, though its page was cached, and the new one works", async () => {
    const mine = await newRestaurant("Stew");
    const theirs = await newRestaurant("Curry");
    const oldToken = mine.qrToken;
    // Cached, so only the tag can take it down: five minutes is the ceiling.
    expect(cacheStatus(await visit(`/t/${oldToken}`))).toBe("MISS");
    expect(cacheStatus(await visit(`/t/${oldToken}`))).toBe("HIT");
    await visit(`/t/${theirs.qrToken}`);
    const cookie = await signInAsOwnerOf(mine.id);

    const response = await regenerate(mine, cookie);

    expect(response.status).toBe(303);
    const old = await visit(`/t/${oldToken}`);
    expect(old.status).toBe(404);
    expect(await old.text()).toContain("This code is out of date");
    const fresh = await visit(`/t/${await tokenNow(mine.tableId)}`);
    expect(fresh.status).toBe(200);
    expect(await fresh.text()).toContain("Stew");
    expect(cacheStatus(await visit(`/t/${theirs.qrToken}`))).toBe("HIT");
  });

  it("refuses another restaurant's table, and its code keeps working", async () => {
    const mine = await newRestaurant("Stew");
    const theirs = await newRestaurant("Curry");
    const cookie = await signInAsOwnerOf(mine.id);

    const response = await regenerate(theirs, cookie);

    expect(response.status).toBe(404);
    expect((await visit(`/t/${theirs.qrToken}`)).status).toBe(200);
  });

  it("holds neither token in the server's output", () => {
    expect(serverOutput).not.toMatch(/\/t\/[0-9A-Za-z]{22}\b/);
  });
});

/**
 * Ordering from a table's page (spec 06, S-32): the page stays cached exactly as
 * before, and its script's writes go to uncached endpoints of their own.
 */
describe("ordering from a table's page", () => {
  const post = (path: string, body?: URLSearchParams, from = origin) =>
    visit(path, { method: "POST", headers: { origin: from }, body });

  it("orders over real HTTP while the page stays cached and unchanged", async () => {
    const restaurant = await newRestaurant("Stew");
    const page = `/t/${restaurant.qrToken}`;
    const first = await visit(page);
    const before = await first.text();
    expect(cacheStatus(first)).toBe("MISS");
    expect(before).toContain('class="add"');
    expect(before.match(/<script/g)).toHaveLength(1);
    const [, item] = /data-item="([0-9a-f-]+)"/.exec(before) ?? [];

    const scan = await post(`/api/t/${restaurant.qrToken}/session`);
    expect(scan.status).toBe(200);
    expect(scan.headers.get("cache-control")).toContain("no-store");
    const { session } = await scan.json();
    const order = await post(
      `/api/t/${restaurant.qrToken}/orders`,
      new URLSearchParams({ item, quantity: "2", name: "Production guest", session }),
    );
    expect(order.status).toBe(201);
    expect(order.headers.get("cache-control")).toContain("no-store");
    expect(await order.json()).toEqual({ placed: { lines: [{ name: "Stew", quantity: 2 }] } });

    // The tracker shows the table's items, fresh every time, and the page is untouched.
    const tracked = await visit(`/api/t/${restaurant.qrToken}/tracker`);
    expect(tracked.status).toBe(200);
    expect(tracked.headers.get("cache-control")).toContain("no-store");
    expect(cacheStatus(tracked)).toBeNull();
    const feed = await tracked.json();
    expect(feed.session).toBe(session);
    expect(feed.items).toEqual([
      expect.objectContaining({ quantity: 2, name: "Stew", customer: "Production guest", status: "placed" }),
    ]);

    const after = await visit(page);
    expect(cacheStatus(after)).toBe("HIT");
    expect(await after.text()).toBe(before);
    expect(before).not.toContain(session);
  });

  it("answers each scan and order fresh: nothing caches the endpoints", async () => {
    const restaurant = await newRestaurant("Stew");
    const scans = [
      await post(`/api/t/${restaurant.qrToken}/session`),
      await post(`/api/t/${restaurant.qrToken}/session`),
    ];
    for (const scan of scans) expect(cacheStatus(scan)).toBeNull();
    const [a, b] = await Promise.all(scans.map((scan) => scan.json()));
    expect(a.session).toBe(b.session);
  });

  it("refuses a scan or an order from another site", async () => {
    const restaurant = await newRestaurant("Stew");
    const elsewhere = "https://elsewhere.example";
    expect((await post(`/api/t/${restaurant.qrToken}/session`, undefined, elsewhere)).status).toBe(403);
    expect(
      (await post(`/api/t/${restaurant.qrToken}/orders`, new URLSearchParams(), elsewhere)).status,
    ).toBe(403);
  });

  it("is a 404 for an unknown token", async () => {
    expect((await post(`/api/t/no-such-token-${crypto.randomUUID()}/session`)).status).toBe(404);
    expect((await visit(`/api/t/no-such-token-${crypto.randomUUID()}/tracker`)).status).toBe(404);
  });

  it("gives the generic menu no script and no Add button", async () => {
    const restaurant = await newRestaurant("Stew");
    const body = await (await visit(`/m/${restaurant.menuToken}`)).text();
    expect(body).not.toContain("<script");
    expect(body).not.toContain('class="add"');
  });
});
