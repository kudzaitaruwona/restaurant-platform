import { and, eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bookings, restaurants, servicePeriods } from "@/db/schema";
import { addDays, dateLabel, localToday, weekdayOf } from "@/lib/booking-engine";
import { getBookingPage } from "@/lib/bookings";
import { resolvePublicToken } from "@/lib/tenant/public";
import { aBooking, bookableRestaurant } from "../../../../../test/integration/bookings";
import {
  openOwnerDatabase,
  testDatabaseSettings,
} from "../../../../../test/integration/database";
import { statusOf } from "../../../../../test/integration/http";
import Page from "./page";
import { BookingSteps, TimeGrid } from "./booking-steps";
import { AlreadyBooked, refusalOf, RefusalNotice } from "./details-form";

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

/** The page's radios of one name, in order: value, and whether checked or disabled. */
const radios = (page: string, name: string) =>
  [...page.matchAll(new RegExp(`<input[^>]*name="${name}"[^>]*>`, "g"))].map(([tag]) => ({
    value: /value="([^"]*)"/.exec(tag)?.[1],
    checked: tag.includes('checked=""'),
    disabled: tag.includes('disabled=""'),
  }));

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

    const sizes = radios(page, "party").map((radio) => radio.value);
    expect(sizes).toEqual(["1", "2", "3", "4"]);
    expect(page).toContain(">4+</span>");
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
    expect(radios(page, "party").find((radio) => radio.checked)?.value).toBe("7");
    expect(page).toContain(">7+</span>");
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

    const dates = radios(page, "date");
    expect(dates).toHaveLength(8);
    expect(dates[0].value).toBe(localToday(new Date(), "Africa/Harare"));
    expect(dates[7].value).toBe(addDays(localToday(new Date(), "Africa/Harare"), 7));
    expect(dates[3].disabled).toBe(true);
    expect(dates[4].disabled).toBe(false);
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
    // A chosen time reloads onto the details, not the top of the page.
    expect(page).toContain(`time=21:00#details`);
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

describe("the choices and the times under them (#103)", () => {
  const tags = (page: string, name: string) =>
    [...page.matchAll(new RegExp(`<input[^>]*name="${name}"[^>]*>`, "g"))].map(([tag]) => tag);
  const loaded = (page: string, name: string) =>
    tags(page, name)
      .filter((tag) => tag.includes("data-loaded"))
      .map((tag) => /value="([^"]*)"/.exec(tag)?.[1]);

  it("names the chosen date above its times", async () => {
    const { slug } = await bookableRestaurant(owner.db);

    const page = await render(slug, { party: "2", date: tomorrow() });

    expect(page).toContain(`Available times on ${dateLabel(tomorrow())}`);
  });

  it("marks the party and date the times are for, and hides times and details once either differs", async () => {
    const { slug } = await bookableRestaurant(owner.db);

    const page = await render(slug, { party: "2", date: tomorrow(), time: "19:00" });

    expect(loaded(page, "party")).toEqual(["2"]);
    expect(loaded(page, "date")).toEqual([tomorrow()]);
    const hidesWhenChanged = "group-has-[[data-loaded]:not(:checked)]/steps:hidden";
    const tag = (pattern: RegExp) => pattern.exec(page)?.[0];
    // renderToStaticMarkup escapes the ampersands only, not brackets.
    expect(tag(/<section[^>]*aria-label="Available times"[^>]*>/)).toContain(hidesWhenChanged);
    expect(tag(/<form[^>]*id="details"[^>]*>/)).toContain(hidesWhenChanged);
    expect(page).toContain("Show times to see what");
  });

  it("marks nothing while no times are shown, and only the party on the large-group message", async () => {
    const { slug } = await bookableRestaurant(owner.db, { rules: { maxOnlinePartySize: 2 } });

    expect(await render(slug)).not.toContain("data-loaded=");

    const large = await render(slug, { party: "3", date: tomorrow() });
    expect(loaded(large, "party")).toEqual(["3"]);
    expect(loaded(large, "date")).toEqual([]);

    // A size past the last option is the last option, so changing it can be seen.
    expect(loaded(await render(slug, { party: "50" }), "party")).toEqual(["3"]);
  });

  it("leaves steps that need no script: links for times, a GET form for party and date", async () => {
    const { slug } = await bookableRestaurant(owner.db);

    const page = await render(slug, { party: "2", date: tomorrow() });

    expect(page).toContain(`href="?party=2&amp;date=${tomorrow()}&amp;time=19:00#details"`);
    expect(page).toMatch(/<form[^>]*method="get"/);
    expect(page).not.toContain('inert=""');
  });

  const grid = (time: string | undefined, available?: { period: string; time: string }[]) =>
    renderToStaticMarkup(
      <BookingSteps action="/api/r/x/book" time={time} initialAvailable={available}>
        <TimeGrid
          party={2}
          date="2026-11-28"
          dateLabel="Sat 28 Nov"
          times={[{ period: "Lunch", time: "12:00" }, { period: "Dinner", time: "19:00" }]}
        />
      </BookingSteps>,
    );

  it("shows the current choice, and what the last refusal left in place of the times it loaded", () => {
    expect(/<a[^>]*time=19:00[^>]*>/.exec(grid("19:00"))?.[0]).toContain("aria-current");

    const after = grid("20:00", [{ period: "Dinner", time: "20:00" }]);
    expect(after).not.toContain("19:00");
    expect(after).not.toContain("Lunch");
    expect(/<a[^>]*time=20:00[^>]*>/.exec(after)?.[0]).toContain("aria-current");

    expect(grid(undefined, [])).toContain("No tables for 2 on Sat 28 Nov.");
  });
});

describe("a refusal (#103)", () => {
  const notice = (refusal: Parameters<typeof RefusalNotice>[0]["refusal"]) =>
    renderToStaticMarkup(<RefusalNotice refusal={refusal} choose={() => {}} open={() => {}} />);

  it("can take focus and is announced", () => {
    const html = notice({ error: "That number looks too short." });

    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('role="alert"');
  });

  it("labels the nearest times with their period", () => {
    const html = notice({
      error: "Gone",
      times: [
        { period: "Dinner", time: "18:00" },
        { period: "Lunch", time: "14:00" },
        { period: "Dinner", time: "18:30" },
      ],
    });

    expect(html).toMatch(/Dinner<.*18:00.*18:30.*Lunch<.*14:00/);
  });

  const contact = { contactPhone: "+263771234567", whatsappLink: "https://wa.me/263771234567" };

  it("gives the restaurant's number when there were too many attempts, and only then adds it", () => {
    const limited = refusalOf(429, { error: "Too many" }, contact);
    expect(notice(limited)).toContain('href="tel:+263771234567"');
    expect(notice(limited)).toContain('href="https://wa.me/263771234567"');

    expect(notice(refusalOf(400, { error: "Too short" }, contact))).not.toContain("tel:");
    // A refusal that brings its own contacts keeps them.
    expect(refusalOf(409, { error: "x", contactPhone: "+2637" }, contact).contactPhone).toBe("+2637");
    expect(notice(refusalOf(429, { error: "Too many" }, { contactPhone: null, whatsappLink: null }))).not.toContain("tel:");
  });

  it("is given the restaurant's contacts by the page", async () => {
    const { slug } = await bookableRestaurant(owner.db);
    const tenant = await resolvePublicToken("slug", slug);

    expect(await getBookingPage(tenant!, {})).toMatchObject(contact);
  });
});

describe("a retry refused because it had other details (#134)", () => {
  const refusal = { error: "Your earlier try did go through", alreadyBooked: true };

  it("offers the booking a lost try made, without its token in the page", () => {
    const html = renderToStaticMarkup(
      <RefusalNotice refusal={{ ...refusal, booked: "/b/AbC?booked=1" }} choose={() => {}} open={() => {}} />,
    );

    expect(html).toContain("Your earlier try did go through");
    expect(html).toContain("Open that booking");
    expect(html).not.toContain("/b/");
  });

  it("offers none when the page can't say which it is", () => {
    const html = renderToStaticMarkup(<RefusalNotice refusal={refusal} choose={() => {}} open={() => {}} />);

    expect(html).not.toContain("Open that booking");
  });
});

describe("in the form's place after booking (#89)", () => {
  it("has no form to send again, and no token in the page", () => {
    const html = renderToStaticMarkup(<AlreadyBooked again={() => {}} />);

    expect(html).toContain("You booked from this tab");
    expect(html).toContain("If you have already cancelled it, you can make another booking.");
    // The booking may be cancelled, or past its cutoff: nothing says otherwise.
    expect(html).not.toContain("You&#x27;re booked");
    expect(html).toContain("Make another booking");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("/b/");
  });

  it("offers the booking while its page opens, and no second booking", () => {
    const html = renderToStaticMarkup(<AlreadyBooked open={() => {}} />);

    expect(html).toContain("You&#x27;re booked");
    expect(html).toContain("Open your booking");
    expect(html).not.toContain("Make another booking");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("/b/");
  });
});
