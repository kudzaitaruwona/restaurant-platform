import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { categories, diningTables, menuItems, restaurants, staff } from "../../src/db/schema";
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

async function newRestaurant(dish: string) {
  const id = crypto.randomUUID();
  const menuToken = `production-${id}`;
  await owner.db.insert(restaurants).values({
    id,
    name: `Restaurant ${id}`,
    slug: menuToken,
    menuToken,
    currencyMode: "usd_only",
  });
  const categoryId = crypto.randomUUID();
  await owner.db.insert(categories).values({ id: categoryId, restaurantId: id, name: "Mains" });
  await owner.db
    .insert(menuItems)
    .values({ restaurantId: id, categoryId, name: dish, priceUsd: "8" });
  // 22 base62 characters, and unique to this restaurant.
  const qrToken = id.replaceAll("-", "").slice(0, 22).padEnd(22, "0");
  await owner.db
    .insert(diningTables)
    .values({ restaurantId: id, label: "7", capacity: 4, qrToken });
  return { id, menuToken, qrToken, categoryId };
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
});
