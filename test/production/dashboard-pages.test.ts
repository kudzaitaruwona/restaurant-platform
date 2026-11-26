import { type ChildProcess, spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { categories, menuItems, staff, staffAuthRateLimit } from "../../src/db/schema";
import { bookableRestaurant } from "../integration/bookings";
import {
  openOwnerDatabase,
  systemDatabaseSettings,
  testDatabaseSettings,
} from "../integration/database";

/**
 * Every dashboard page, rendered by the real server through its server and
 * client boundaries (#137). Under `vitest` a page is a plain function and a
 * 'use client' module a plain module, so a server component that calls a
 * non-component export of one (#118's first version did, on every owner page)
 * runs fine there and fails only in the built app, where the client module is
 * a reference to code in the browser's bundle and has no such function to call.
 * Needs `npm run build` first, like the rest of `test:production`.
 */

const owner = openOwnerDatabase();
let server: ChildProcess;
let origin: string;
let serverOutput = "";
let cookie: string;
let tableId: string;

/**
 * Each page's address, and a sign that it drew itself. A new page has to be
 * added here: the last test fails on one that isn't.
 */
const pages: Record<string, { url: () => string; shows: string }> = {
  "/dashboard": { url: () => "/dashboard", shows: "Every booking so far" },
  "/dashboard/[...unknown]": {
    url: () => "/dashboard/no-such-page",
    // Streamed, so the status is already 200: the page says it is not found.
    shows: "<title>Page not found",
  },
  "/dashboard/bookings": { url: () => "/dashboard/bookings", shows: "No bookings on this day." },
  "/dashboard/bookings/new": { url: () => "/dashboard/bookings/new", shows: "Add booking" },
  "/dashboard/bookings/settings": { url: () => "/dashboard/bookings/settings", shows: "Copy link" },
  "/dashboard/floor": { url: () => "/dashboard/floor", shows: ">T1<" },
  "/dashboard/floor/[tableId]": { url: () => `/dashboard/floor/${tableId}`, shows: ">Refresh<" },
  "/dashboard/kitchen": { url: () => "/dashboard/kitchen", shows: "No orders waiting" },
  "/dashboard/menu": { url: () => "/dashboard/menu", shows: "Starters" },
  "/dashboard/settings": { url: () => "/dashboard/settings", shows: "Restaurant name" },
  "/dashboard/staff": { url: () => "/dashboard/staff", shows: "Add someone" },
  "/dashboard/tables": { url: () => "/dashboard/tables", shows: "Add a table" },
  "/dashboard/tables/print": { url: () => "/dashboard/tables/print", shows: "Print on A4" },
};

/** The routes that exist, as the app directory has them. */
function dashboardRoutes(dir = "src/app/dashboard", route = "/dashboard"): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      found.push(...dashboardRoutes(join(dir, entry.name), `${route}/${entry.name}`));
    } else if (entry.name === "page.tsx") found.push(route);
  }
  return found;
}

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
    if (server.exitCode !== null) throw new Error(`next start exited early:\n${serverOutput}`);
    const result = await attempt().catch(() => undefined);
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${what}:\n${serverOutput}`);
}

beforeAll(async () => {
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  server = spawn("node_modules/.bin/next", ["start", "-H", "127.0.0.1", "-p", String(port)], {
    env: {
      ...process.env,
      // Env validation refuses NEON_WS_PROXY under production; the bundle is still the build.
      NODE_ENV: "test",
      DATABASE_URL: testDatabaseSettings().connectionString,
      NEXT_PUBLIC_APP_URL: origin,
      AUTH_SECRET: "a-stand-in-of-at-least-32-characters",
      // Blank, so the sign-in link goes to the console for us to read.
      RESEND_API_KEY: "",
      DATABASE_URL_SYSTEM: systemDatabaseSettings().connectionString,
    },
  });
  server.stdout?.on("data", (chunk) => (serverOutput += chunk));
  server.stderr?.on("data", (chunk) => (serverOutput += chunk));
  await waitFor("the server", async () => (await fetch(`${origin}/login`)).ok || undefined);

  // A restaurant with a table, a booking window and a menu, and its owner, signed in as a real owner would.
  const restaurant = await bookableRestaurant(owner.db, { tables: [{ capacity: 4 }] });
  tableId = restaurant.tableIds[0];
  const [starters] = await owner.db
    .insert(categories)
    .values({ restaurantId: restaurant.restaurantId, name: "Starters" })
    .returning();
  await owner.db.insert(menuItems).values({
    restaurantId: restaurant.restaurantId,
    categoryId: starters.id,
    name: "Mopane worms",
    priceUsd: "6",
  });
  const email = `${restaurant.restaurantId}@dashboard-pages.example.test`;
  await owner.db.insert(staff).values({
    restaurantId: restaurant.restaurantId,
    email,
    displayName: "Owner",
    role: "owner",
  });
  // Rate limited per address and kept in the database.
  await owner.db.delete(staffAuthRateLimit);
  await fetch(`${origin}/api/auth/staff/sign-in/magic-link`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ email, callbackURL: "/dashboard", errorCallbackURL: "/login" }),
  });
  const link = await waitFor("the sign-in email", async () => {
    const [, sent] = serverOutput.match(new RegExp(`Email to ${email}[\\s\\S]*?(http\\S+verify\\S+)`)) ?? [];
    return sent;
  });
  const signedIn = await fetch(link, { redirect: "manual" });
  cookie = signedIn.headers
    .getSetCookie()
    .map((part) => part.split(";")[0])
    .join("; ");
  expect(cookie).not.toBe("");
});

afterAll(async () => {
  server?.kill();
  await owner.pool.end();
});

describe("every dashboard page, as an owner, on the production build", () => {
  it("has an entry here for every page.tsx under src/app/dashboard", () => {
    expect(dashboardRoutes().sort()).toEqual(Object.keys(pages).sort());
  });

  it.each(Object.entries(pages))("renders %s through its server and client boundaries", async (_route, page) => {
    const before = serverOutput.length;
    const response = await fetch(`${origin}${page.url()}`, { headers: { cookie } });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain(page.shows);
    // A boundary that caught a render error leaves its marker in the streamed HTML (the
    // page's own error screen is drawn in the browser, so its words are not there).
    expect(html).not.toContain("<!--$!-->");
    expect(html).not.toContain("data-dgst");
    // And the server logs what it threw: "⨯ Error: Attempted to call ... from the server".
    const logged = serverOutput.slice(before);
    expect(logged).not.toMatch(/⨯|Attempted to call|Error:/);
  });
});
