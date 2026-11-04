import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bookings } from "@/db/schema";
import { aBooking, bookableRestaurant } from "../../../../test/integration/bookings";
import { openOwnerDatabase, testDatabaseSettings } from "../../../../test/integration/database";
import { GET, POST } from "./route";

/** The guest's manage page, through its handlers, as a browser reaches them. */
const owner = openOwnerDatabase();

beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});
afterAll(async () => {
  await owner.pool.end();
  vi.unstubAllEnvs();
});

const MINUTE = 60_000;
const soon = (minutes: number) => new Date(Date.now() + minutes * MINUTE);

async function bookedIn(minutes: number, extra: Partial<typeof bookings.$inferInsert> = {}) {
  const restaurant = await bookableRestaurant(owner.db);
  const row = {
    ...aBooking(
      restaurant.restaurantId,
      restaurant.tableIds[0],
      soon(minutes).toISOString(),
      soon(minutes + 90).toISOString(),
    ),
    ...extra,
  };
  await owner.db.insert(bookings).values(row);
  return { ...restaurant, token: row.manageToken };
}

const params = (manageToken: string) => ({ params: Promise.resolve({ manageToken }) });
const view = (token: string) => GET(new Request(`http://localhost/b/${token}`), params(token));
const cancel = (token: string, body?: FormData) =>
  POST(new Request(`http://localhost/b/${token}`, { method: "POST", body }), params(token));
const statusOf = async (token: string) =>
  (await owner.db.select().from(bookings).where(eq(bookings.manageToken, token)))[0].status;

const TOO_LATE = "Too late to cancel online — please call.";

describe("GET /b/{manage_token}", () => {
  it("shows the booking, with a cancel that is a POST form and nothing external", async () => {
    const { token } = await bookedIn(300, { guestName: "Tariro" });

    const response = await view(token);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const page = await response.text();
    expect(page).toMatch(/^<!doctype html>/i);
    expect(page).toContain("Tariro");
    expect(page).toContain("party of 2");
    expect(page).toMatch(new RegExp(`<form method="post" action="/b/${token}">`));
    expect(page).toContain("Cancel booking");
    expect(page).not.toContain("<script");
    expect(page).not.toMatch(/(href|src|action)="(https?:)?\/\//);
    expect(page).toContain('name="robots" content="noindex"');
    // Not no-referrer: Chrome would post the cancel form with Origin: null, and the
    // proxy refuses that.
    expect(page).toContain('name="referrer" content="same-origin"');
  });

  it.each(["found", "missing", "nul"])(
    "keeps the token off other sites and out of every cache: %s",
    async (which) => {
      const { token } = await bookedIn(300);
      const response = await view(
        which === "found" ? token : which === "missing" ? "no-such-token" : "a\0b",
      );

      expect(response.headers.get("referrer-policy")).toBe("same-origin");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("x-robots-tag")).toContain("noindex");
    },
  );

  it("is a real 404 for an unknown token and for a NUL", async () => {
    expect((await view("no-such-token")).status).toBe(404);
    expect((await view("a\0b")).status).toBe(404);
  });

  it("never cancels: a link preview that opens it changes nothing", async () => {
    const { token } = await bookedIn(300);
    await view(token);
    await view(token);
    expect(await statusOf(token)).toBe("confirmed");
  });

  it("shows the cutoff message, and no cancel, once it has passed", async () => {
    const { token } = await bookedIn(110);

    const page = await (await view(token)).text();

    expect(page).toContain(TOO_LATE);
    expect(page).not.toContain("<form");
  });

  it("shows the restaurant's number to call", async () => {
    const { token } = await bookedIn(110);
    expect(await (await view(token)).text()).toContain('href="tel:+263771234567"');
  });

  it.each([
    ["seated", "seated"],
    ["completed", "complete"],
    ["no_show", "no-show"],
    ["cancelled", "cancelled"],
  ] as const)("a %s booking shows its state and offers no cancel", async (status, word) => {
    const { token } = await bookedIn(300, { status });

    const page = await (await view(token)).text();

    expect(page.toLowerCase()).toContain(word);
    expect(page).not.toContain("<form");
  });

  it("escapes what the guest typed", async () => {
    const { token } = await bookedIn(300, {
      guestName: "<script>alert(1)</script>",
      guestNote: "<img src=x onerror=1>",
    });

    const page = await (await view(token)).text();

    expect(page).not.toContain("<script>alert");
    expect(page).not.toContain("<img");
    expect(page).toContain("&lt;script&gt;");
  });

  it("shows no table", async () => {
    const restaurant = await bookableRestaurant(owner.db, { tables: [{ label: "Window-9", capacity: 2 }] });
    const start = soon(300);
    const row = aBooking(restaurant.restaurantId, restaurant.tableIds[0], start.toISOString(), soon(390).toISOString());
    await owner.db.insert(bookings).values(row);

    expect(await (await view(row.manageToken)).text()).not.toContain("Window-9");
  });
});

describe("POST /b/{manage_token}", () => {
  it("cancels before the cutoff and says so, with the same protective headers", async () => {
    const { token } = await bookedIn(300);

    const response = await cancel(token);

    expect(response.status).toBe(200);
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const page = await response.text();
    expect(page).toContain("Your booking is cancelled.");
    expect(page).not.toContain("<form");
    expect(await statusOf(token)).toBe("cancelled");
  });

  it("twice is safe, and the second says it was already cancelled", async () => {
    const { token } = await bookedIn(300);
    await cancel(token);

    const again = await cancel(token);

    expect(again.status).toBe(200);
    expect(await again.text()).toContain("This booking was already cancelled.");
    expect(await statusOf(token)).toBe("cancelled");
  });

  it("is refused after the cutoff, with the cutoff message, and changes nothing", async () => {
    const { token } = await bookedIn(110);

    const response = await cancel(token);

    expect(response.status).toBe(409);
    expect(await response.text()).toContain(TOO_LATE);
    expect(await statusOf(token)).toBe("confirmed");
  });

  it("is refused for a booking already seated", async () => {
    const { token } = await bookedIn(300, { status: "seated" });

    const response = await cancel(token);

    expect(response.status).toBe(409);
    expect(await statusOf(token)).toBe("seated");
  });

  it("is a 404 for an unknown token and a NUL", async () => {
    expect((await cancel("no-such-token")).status).toBe(404);
    expect((await cancel("a\0b")).status).toBe(404);
  });

  it("takes nothing from the body: not a time, a status or a restaurant", async () => {
    const { token, restaurantId } = await bookedIn(110);
    const body = new FormData();
    body.set("now", "2000-01-01T00:00:00Z");
    body.set("status", "seated");
    body.set("restaurantId", restaurantId);
    body.set("cancelledBy", "staff");

    const response = await cancel(token, body);

    expect(response.status).toBe(409);
    expect(await statusOf(token)).toBe("confirmed");
  });
});
