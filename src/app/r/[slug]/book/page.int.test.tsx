import { and, eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bookings, restaurants, servicePeriods } from "@/db/schema";
import { addDays, localToday, weekdayOf } from "@/lib/booking-engine";
import { aBooking, bookableRestaurant } from "../../../../../test/integration/bookings";
import {
  openOwnerDatabase,
  testDatabaseSettings,
} from "../../../../../test/integration/database";
import { statusOf } from "../../../../../test/integration/http";
import Page from "./page";
import { Confirmed } from "./details-form";

// Only a real request has a connection to wait for.
vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));

/** The guest's page as the server renders it, on restaurants of its own. */
const owner = openOwnerDatabase();

beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});
afterAll(async () => {
  await owner.pool.end();
  vi.unstubAllEnvs();
});

const render = async (slug: string, query: Record<string, string> = {}) =>
  renderToStaticMarkup(
    await Page({ params: Promise.resolve({ slug }), searchParams: Promise.resolve(query) }),
  );

const tomorrow = () => addDays(localToday(new Date(), "Africa/Harare"), 1);

describe("the booking page", () => {
  it("is a 404 for a slug no restaurant has", async () => {
    expect(await statusOf(() => render("no-such-restaurant"))).toBe(404);
  });

  it("is a 404 and not a 500 for a NUL in the slug", async () => {
    expect(await statusOf(() => render("a\0b"))).toBe(404);
  });

  it("is a friendly closed page while online booking is off, with no way to book", async () => {
    const { slug } = await bookableRestaurant(owner.db, { rules: { enabled: false } });

    const page = await render(slug, { party: "2", date: tomorrow(), time: "19:00" });

    expect(page).toContain("Online booking isn&#x27;t available right now");
    expect(page).toContain("tel:+263771234567");
    expect(page).not.toContain("Party size");
    expect(page).not.toContain("WhatsApp number");
  });

  it("offers party sizes from 1 to max_online_party_size, then a final option above it", async () => {
    const { slug } = await bookableRestaurant(owner.db, { rules: { maxOnlinePartySize: 3 } });

    const page = await render(slug);

    const sizes = [...page.matchAll(/<option value="(\d+)"/g)].map((match) => match[1]);
    expect(sizes).toEqual(["1", "2", "3", "4"]);
    expect(page).toContain(">4+</option>");
  });

  it("shows the contact message with the number and a WhatsApp link for the final option, not an empty list", async () => {
    const { slug } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 6 }],
      rules: { maxOnlinePartySize: 6 },
    });

    const page = await render(slug, { party: "7", date: tomorrow() });

    expect(page).toContain("For groups of 7+, contact the restaurant");
    expect(page).toContain('href="tel:+263771234567"');
    expect(page).toContain('href="https://wa.me/263771234567"');
    expect(page).not.toContain("No tables for");
    expect(page).not.toContain("Available times");
    expect(page).toContain('<option value="7" selected="">7+</option>');
  });

  it("says the same for a size that fits online but no bookable table", async () => {
    const { slug } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 4 }],
      rules: { maxOnlinePartySize: 8 },
    });

    const page = await render(slug, { party: "6", date: tomorrow() });

    expect(page).toContain("For groups of 5+, contact the restaurant");
    expect(page).not.toContain("No tables for");
  });

  it("gives the number but no WhatsApp link when the contact number can't make one", async () => {
    const { slug, restaurantId } = await bookableRestaurant(owner.db, { rules: { maxOnlinePartySize: 2 } });
    await owner.db.update(restaurants).set({ contactPhone: "+12" }).where(eq(restaurants.id, restaurantId));

    const page = await render(slug, { party: "3", date: tomorrow() });

    expect(page).toContain("For groups of 3+, contact the restaurant");
    expect(page).toContain('href="tel:+12"');
    expect(page).not.toContain("wa.me");
  });

  it("offers local today to max_days_ahead, with dates that have no service disabled", async () => {
    const { slug, restaurantId } = await bookableRestaurant(owner.db, {
      rules: { maxDaysAhead: 7, minLeadMinutes: 0 },
    });
    const closedDay = addDays(localToday(new Date(), "Africa/Harare"), 3);
    await owner.db
      .delete(servicePeriods)
      .where(
        and(
          eq(servicePeriods.restaurantId, restaurantId),
          eq(servicePeriods.weekday, weekdayOf(closedDay)),
        ),
      );

    const page = await render(slug);

    const dates = [...page.matchAll(/<option value="(\d{4}-\d{2}-\d{2})"( disabled="")?/g)];
    expect(dates).toHaveLength(8);
    expect(dates[0][1]).toBe(localToday(new Date(), "Africa/Harare"));
    expect(dates[7][1]).toBe(addDays(localToday(new Date(), "Africa/Harare"), 7));
    expect(dates[3][2]).toBeDefined();
    expect(dates[4][2]).toBeUndefined();
  });

  it("groups the times by service period, and only what can be seated", async () => {
    const { slug, restaurantId } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 4, label: "Secret corner" }],
    });
    await owner.db.insert(servicePeriods).values({
      restaurantId,
      name: "Lunch",
      weekday: weekdayOf(tomorrow()),
      opensAt: "12:00",
      lastBookingAt: "12:30",
      closesAt: "14:00",
    });

    const page = await render(slug, { party: "2", date: tomorrow() });

    expect(page.indexOf("Lunch")).toBeGreaterThan(-1);
    expect(page.indexOf("Lunch")).toBeLessThan(page.indexOf("Dinner"));
    expect(page).toContain(`time=12:30`);
    expect(page).toContain(`time=21:00`);
    expect(page).not.toContain("Secret corner");
  });

  it("gives the contact message, not an empty list, when no table fits the party (D-02)", async () => {
    const { slug } = await bookableRestaurant(owner.db);

    const page = await render(slug, { party: "3", date: tomorrow() });

    expect(page).toContain("For groups of 3+, contact the restaurant");
    expect(page).not.toContain("No tables for");
  });

  it("says no tables are free, for a party that fits, when every table is taken that day", async () => {
    const { slug, restaurantId, tableIds } = await bookableRestaurant(owner.db);
    const day = tomorrow();
    await owner.db.insert(bookings).values(
      aBooking(restaurantId, tableIds[0], `${day}T14:00:00Z`, `${day}T21:00:00Z`),
    );

    const page = await render(slug, { party: "2", date: day });

    expect(page).toContain("No tables for 2");
  });

  it("asks for the details once a time is chosen, with the consent and +263", async () => {
    const { slug } = await bookableRestaurant(owner.db);

    const page = await render(slug, { party: "2", date: tomorrow(), time: "19:00" });

    expect(page).toContain("Send my confirmation and reminder on WhatsApp.");
    const field = (name: string) => new RegExp(`<[^>]*name="${name}"[^>]*>`).exec(page)?.[0];
    expect(field("consent")).toContain("required");
    expect(field("name")).toContain("required");
    expect(field("phone")).toContain("required");
    expect(field("countryCode")).toContain('value="+263"');
    expect(field("note")).toContain('maxLength="200"');
    expect(field("note")).not.toContain("required");
  });

  it("posts to the route, never gets, so nothing typed can reach a URL before the script runs", async () => {
    const { slug } = await bookableRestaurant(owner.db);

    const page = await render(slug, { party: "2", date: tomorrow(), time: "19:00" });

    // The details form, not the party-and-date one above it, which is meant to be a GET.
    const form = [...page.matchAll(/<form[^>]*>/g)]
      .map((match) => match[0])
      .find((tag) => tag.includes("/api/r/"));
    expect(form).toContain('method="post"');
    expect(form).toContain(`action="/api/r/${slug}/book"`);
    // And the button waits for the script, so a guest isn't sent to raw JSON.
    const submit = [...page.matchAll(/<button[^>]*type="submit"[^>]*>/g)].map((match) => match[0]);
    expect(submit.at(-1)).toContain("disabled");
  });

  it("doesn't ask for details for a time that can't be seated", async () => {
    const { slug } = await bookableRestaurant(owner.db);

    const page = await render(slug, { party: "2", date: tomorrow(), time: "19:07" });

    expect(page).not.toContain("WhatsApp number");
  });

  it("ignores a restaurant id in the query", async () => {
    const mine = await bookableRestaurant(owner.db);
    const theirs = await bookableRestaurant(owner.db);

    const page = await render(mine.slug, { restaurantId: theirs.restaurantId });

    expect(page).toContain(mine.restaurantId);
    expect(page).not.toContain(theirs.restaurantId);
  });
});

describe("the confirmation", () => {
  const confirmation = {
    restaurantName: "Mbira Kitchen",
    dateLabel: "Fri 6 Nov",
    time: "19:00",
    party: 4,
    manageToken: "AbCdEfGhIjKlMnOpQrStUv",
    contactPhone: "+263771234567",
  };

  it("shows restaurant, date, time and party, the cancel link and the contact number", () => {
    const html = renderToStaticMarkup(<Confirmed confirmation={confirmation} />);

    expect(html).toContain("Mbira Kitchen, Fri 6 Nov at 19:00, party of 4");
    expect(html).toMatch(/<a[^>]*href="\/b\/AbCdEfGhIjKlMnOpQrStUv"[^>]*>Cancel booking<\/a>/);
    expect(html).toContain('href="tel:+263771234567"');
  });

  it("leaves the phone line out when the restaurant has none, and never shows a table", () => {
    const html = renderToStaticMarkup(
      <Confirmed confirmation={{ ...confirmation, contactPhone: null }} />,
    );

    expect(html).not.toContain("tel:");
    expect(html).toContain("Cancel booking");
    expect(html.toLowerCase()).not.toContain("table");
  });
});
