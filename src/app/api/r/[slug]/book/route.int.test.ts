import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bookings } from "@/db/schema";
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
