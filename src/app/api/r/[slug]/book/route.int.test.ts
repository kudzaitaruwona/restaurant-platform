import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { bookingRateLimit, bookings } from "@/db/schema";
import { ipBucket, limitKey, MAX_BODY_BYTES } from "@/lib/booking-limits";
import { addDays, localToday } from "@/lib/booking-engine";
import {
  aBooking,
  bookableRestaurant,
  bookingsOf,
} from "../../../../../../test/integration/bookings";
import {
  openOwnerDatabase,
  testDatabaseSettings,
} from "../../../../../../test/integration/database";
import { POST } from "./route";

/** A guest's confirm through the route, as the page's form sends it. */
const owner = openOwnerDatabase();

beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});
afterAll(async () => {
  await owner.pool.end();
  vi.unstubAllEnvs();
});

const tomorrow = () => addDays(localToday(new Date(), "Africa/Harare"), 1);

const post = (slug: string, fields: Record<string, string> = {}) => {
  const body = new FormData();
  for (const [key, value] of Object.entries({
    party: "2",
    date: tomorrow(),
    time: "19:00",
    name: "Tariro",
    countryCode: "+263",
    phone: "0771234567",
    consent: "on",
    ...fields,
  })) {
    body.set(key, value);
  }
  return POST(new Request("http://localhost/x", { method: "POST", body }), {
    params: Promise.resolve({ slug }),
  });
};

describe("POST /api/r/[slug]/book", () => {
  it("confirms, and answers with what the confirmation screen shows", async () => {
    const { slug, restaurantId, tableIds } = await bookableRestaurant(owner.db);

    const response = await post(slug, { note: "birthday" });

    expect(response.status).toBe(201);
    const { confirmation } = await response.json();
    expect(confirmation).toMatchObject({ time: "19:00", party: 2, contactPhone: "+263771234567" });
    expect(Object.keys(confirmation).sort()).toEqual([
      "contactPhone",
      "dateLabel",
      "manageToken",
      "party",
      "restaurantName",
      "time",
    ]);
    const [booked] = await bookingsOf(owner.db, restaurantId);
    expect(booked).toMatchObject({
      tableId: tableIds[0],
      guestPhone: "+263771234567",
      guestNote: "birthday",
      whatsappOptIn: true,
      manageToken: confirmation.manageToken,
    });
  });

  it("gives the race-lost answer with the nearest times when the table has gone", async () => {
    const { slug, restaurantId, tableIds } = await bookableRestaurant(owner.db);
    const day = tomorrow();
    await owner.db
      .insert(bookings)
      .values(aBooking(restaurantId, tableIds[0], `${day}T17:00:00Z`, `${day}T18:00:00Z`));

    const response = await post(slug);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "That time was just booked — here are the nearest available times.",
      times: [{ period: "Dinner", time: "20:00" }, { period: "Dinner", time: "20:30" }, { period: "Dinner", time: "21:00" }],
    });
  });

  it("refuses while online booking is off, and saves nothing", async () => {
    const { slug, restaurantId } = await bookableRestaurant(owner.db, {
      rules: { enabled: false },
    });

    const response = await post(slug);

    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("isn't taking online bookings");
    expect(await bookingsOf(owner.db, restaurantId)).toEqual([]);
  });

  it("refuses with no consent, and saves nothing", async () => {
    const { slug, restaurantId } = await bookableRestaurant(owner.db);

    const response = await post(slug, { consent: "" });

    expect(response.status).toBe(400);
    expect(await bookingsOf(owner.db, restaurantId)).toEqual([]);
  });

  it("saves nothing for a native form post before the script has run", async () => {
    const { slug, restaurantId } = await bookableRestaurant(owner.db);
    // What the browser sends with no script: the visible fields only, no
    // party, date or time (the script adds those).
    const body = new URLSearchParams({
      name: "Tariro",
      countryCode: "+263",
      phone: "0771234567",
      note: "",
      consent: "on",
    });

    const response = await POST(
      new Request("http://localhost/x", { method: "POST", body }),
      { params: Promise.resolve({ slug }) },
    );

    expect(response.status).toBe(400);
    expect(await bookingsOf(owner.db, restaurantId)).toEqual([]);
  });

  it("is a refusal, not a 500, for a NUL in what the guest typed", async () => {
    const { slug } = await bookableRestaurant(owner.db);

    expect((await post(slug, { name: "a\0b" })).status).toBe(400);
    expect((await post(slug, { note: "a\0b" })).status).toBe(400);
  });

  it("is a refusal, not a 500, for a body that isn't a form", async () => {
    const { slug } = await bookableRestaurant(owner.db);

    const response = await POST(
      new Request("http://localhost/x", { method: "POST", body: "{}" }),
      { params: Promise.resolve({ slug }) },
    );

    expect(response.status).toBe(400);
  });

  it("is a 404 for a slug no restaurant has", async () => {
    expect((await post("no-such-restaurant")).status).toBe(404);
  });

  it("doesn't let a time off the grid through", async () => {
    const { slug, restaurantId } = await bookableRestaurant(owner.db);

    const response = await post(slug, { time: "19:07" });

    expect(response.status).toBe(409);
    expect(await bookingsOf(owner.db, restaurantId)).toEqual([]);
  });
});

const tomorrowIn = (days: number) => addDays(localToday(new Date(), "Africa/Harare"), days);

const postWith = (
  slug: string,
  { headers, fields = {}, body }: { headers?: Record<string, string>; fields?: Record<string, string>; body?: BodyInit } = {},
) => {
  const form = new FormData();
  for (const [key, value] of Object.entries({
    party: "2",
    date: tomorrow(),
    time: "19:00",
    name: "Tariro",
    phone: "0771234567",
    consent: "on",
    ...fields,
  })) {
    form.set(key, value);
  }
  return POST(new Request("http://localhost/x", { method: "POST", body: body ?? form, headers }), {
    params: Promise.resolve({ slug }),
  });
};

describe("the refusals, each with its own message", () => {
  it("lead time, with the next times", async () => {
    const { slug, restaurantId } = await bookableRestaurant(owner.db, {
      rules: { minLeadMinutes: 10_080, maxDaysAhead: 30 },
    });

    const response = await postWith(slug, { fields: { date: tomorrow() } });

    expect(response.status).toBe(409);
    const answer = await response.json();
    expect(answer.error).toBe("That time is now too soon to book online — here are the next available times.");
    expect(answer.times).toEqual([]);
    expect(await bookingsOf(owner.db, restaurantId)).toEqual([]);
  });

  it("the phone's limit, with the count", async () => {
    const { slug, tableIds, restaurantId } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 2 }, { capacity: 2 }],
    });
    for (const day of [3, 4]) {
      await owner.db.insert(bookings).values({
        ...aBooking(restaurantId, tableIds[0], `${tomorrowIn(day)}T10:00:00Z`, `${tomorrowIn(day)}T11:00:00Z`),
        guestPhone: "+263771234567",
      });
    }

    const response = await postWith(slug);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "You already have 2 upcoming bookings here. Cancel one or contact the restaurant.",
    });
  });

  it("a party too large, with the number and a WhatsApp link", async () => {
    const { slug } = await bookableRestaurant(owner.db, { tables: [{ capacity: 4 }] });

    const response = await postWith(slug, { fields: { party: "5" } });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "For groups of 5+, contact the restaurant",
      contactPhone: "+263771234567",
      whatsappLink: "https://wa.me/263771234567",
    });
  });

  it.each(["9999-12-31", "0001-01-01", "2020-01-01"])("a crafted date (%s) is a normal refusal, not a 500", async (date) => {
    const { slug } = await bookableRestaurant(owner.db);

    const response = await postWith(slug, { fields: { date } });

    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("That date can't be booked online. Choose another date.");
  });
});

describe("limits on what is sent", () => {
  it("refuses a declared length over the limit before reading or resolving anything", async () => {
    const response = await postWith("no-such-restaurant", {
      headers: { "content-length": String(MAX_BODY_BYTES + 1) },
    });
    // Not a 404: the size is judged first.
    expect(response.status).toBe(413);
  });

  it("refuses a body that is over the limit whatever it declared", async () => {
    const { slug } = await bookableRestaurant(owner.db);
    const big = new FormData();
    big.set("note", "x".repeat(MAX_BODY_BYTES + 1));

    expect((await postWith(slug, { body: big })).status).toBe(413);
  });

  it("refuses an invalid Content-Length", async () => {
    const { slug } = await bookableRestaurant(owner.db);
    expect((await postWith(slug, { headers: { "content-length": "-5" } })).status).toBe(400);
  });

  it.each([
    ["a long country code", { countryCode: "+".padEnd(5000, "2") }],
    ["a long number", { phone: "7".repeat(5000) }],
  ])("is a 400 for %s", async (_name, fields) => {
    const { slug, restaurantId } = await bookableRestaurant(owner.db);

    expect((await postWith(slug, { fields })).status).toBe(400);
    expect(await bookingsOf(owner.db, restaurantId)).toEqual([]);
  });
});

describe("the rate limit", () => {
  const keysUsed: string[] = [];
  const from = (ip: string) => {
    const key = limitKey(ipBucket(ip), process.env.AUTH_SECRET || undefined);
    keysUsed.push(key);
    return { "x-forwarded-for": ip };
  };
  afterEach(async () => {
    for (const key of keysUsed.splice(0)) await owner.db.delete(bookingRateLimit).where(eq(bookingRateLimit.key, key));
  });

  it("lets five through from one address in ten minutes and refuses the sixth, keeping nothing", async () => {
    const { slug, restaurantId } = await bookableRestaurant(owner.db);
    const headers = from("198.51.100.20");
    // Bad forms count as submissions: the limit is on asking.
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await postWith(slug, { headers, fields: { consent: "" } })).status).toBe(400);
    }

    const sixth = await postWith(slug, { headers });

    expect(sixth.status).toBe(429);
    expect(Number(sixth.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await bookingsOf(owner.db, restaurantId)).toEqual([]);
  });

  it("counts addresses separately, and stores a hash, not the address", async () => {
    const { slug } = await bookableRestaurant(owner.db);
    const busy = from("198.51.100.21");
    for (let attempt = 0; attempt < 6; attempt++) await postWith(slug, { headers: busy, fields: { consent: "" } });

    expect((await postWith(slug, { headers: from("198.51.100.22"), fields: { consent: "" } })).status).toBe(400);
    const rows = JSON.stringify(await owner.db.select().from(bookingRateLimit).where(eq(bookingRateLimit.key, limitKey("198.51.100.21", process.env.AUTH_SECRET || undefined))));
    expect(rows).not.toContain("198.51.100.21");
  });

  it("is run before the body is read and before the restaurant is looked up", async () => {
    const headers = from("198.51.100.23");
    for (let attempt = 0; attempt < 5; attempt++) await postWith("no-such-restaurant", { headers });

    expect((await postWith("no-such-restaurant", { headers })).status).toBe(429);
  });

  it("without an address isn't applied in development, and is one shared count in production", async () => {
    const { slug } = await bookableRestaurant(owner.db);
    for (let attempt = 0; attempt < 8; attempt++) {
      expect((await postWith(slug, { fields: { consent: "" } })).status).toBe(400);
    }

    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "secret");
    keysUsed.push(limitKey(undefined, process.env.AUTH_SECRET || undefined));
    try {
      // In production the header x-forwarded-for is the client's word and is ignored.
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 7; attempt++) {
        statuses.push((await postWith(slug, { headers: { "x-forwarded-for": `198.51.100.${30 + attempt}` }, fields: { consent: "" } })).status);
      }
      expect(statuses.slice(-2)).toEqual([429, 429]);
    } finally {
      vi.unstubAllEnvs();
      vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
    }
  });
});

describe("the bot check", () => {
  const siteverify = vi.fn<(body: URLSearchParams) => Response | Promise<Response>>();
  const realFetch = globalThis.fetch;
  const install = (secret = "test-secret") => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", secret);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("cloudflare")) return siteverify(init?.body as URLSearchParams);
      return realFetch(input, init);
    });
  };
  afterEach(() => {
    siteverify.mockReset();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
  });

  it("confirms when the fake says the token is good, and passes it the token and secret", async () => {
    install();
    siteverify.mockResolvedValue(Response.json({ success: true }));
    const { slug } = await bookableRestaurant(owner.db);

    const response = await postWith(slug, { fields: { "cf-turnstile-response": "good-token" } });

    expect(response.status).toBe(201);
    expect(Object.fromEntries(siteverify.mock.calls[0][0])).toMatchObject({ secret: "test-secret", response: "good-token" });
  });

  it("refuses with the spec's message, saving nothing, when the token is rejected or absent", async () => {
    install();
    siteverify.mockResolvedValue(Response.json({ success: false, "error-codes": ["invalid-input-response"] }));
    const { slug, restaurantId } = await bookableRestaurant(owner.db);

    const rejected = await postWith(slug, { fields: { "cf-turnstile-response": "bad" } });
    const absent = await postWith(slug);

    for (const response of [rejected, absent]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "We couldn't verify the request — please try again." });
    }
    expect(await bookingsOf(owner.db, restaurantId)).toEqual([]);
    expect(siteverify).toHaveBeenCalledTimes(1);
  });

  it("goes on when Cloudflare can't be reached", async () => {
    install();
    siteverify.mockRejectedValue(new TypeError("fetch failed"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { slug } = await bookableRestaurant(owner.db);

    expect((await postWith(slug, { fields: { "cf-turnstile-response": "t" } })).status).toBe(201);
  });

  it("is off with no secret in development, and refuses in production", async () => {
    const { slug } = await bookableRestaurant(owner.db);
    expect((await postWith(slug)).status).toBe(201);

    vi.stubEnv("NODE_ENV", "production");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const other = await bookableRestaurant(owner.db);
    expect((await postWith(other.slug)).status).toBe(403);
  });

  it("never reads the token from anywhere but the form body", async () => {
    install();
    siteverify.mockResolvedValue(Response.json({ success: true }));
    const { slug } = await bookableRestaurant(owner.db);

    const response = await postWith(slug, { headers: { "cf-turnstile-response": "t" } });

    expect(response.status).toBe(403);
  });
});
