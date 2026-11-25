import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closures } from "@/db/schema";
import { addDays, instantOf, localToday } from "@/lib/booking-engine";
import type { TenantContext } from "@/lib/tenant";
import { bookableRestaurant } from "../../../../../test/integration/bookings";
import { openOwnerDatabase, testDatabaseSettings } from "../../../../../test/integration/database";
import { NewBookingScreen } from "./new-booking-screen";

/** Add booking as markup, on a restaurant of its own. Who's asking is faked: access.int.test.ts has the real seam. */
const session = vi.hoisted(() => ({ tenant: undefined as unknown }));
vi.mock("@/lib/tenant", async (original) => ({
  ...(await original<typeof import("@/lib/tenant")>()),
  getTenantContext: async () => session.tenant as TenantContext,
}));
vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh() {} }),
}));

const owner = openOwnerDatabase();
beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});
afterAll(async () => {
  await owner.pool.end();
  vi.unstubAllEnvs();
});

const soon = addDays(localToday(new Date(), "Africa/Harare"), 3);
const render = async (query: Record<string, string> = {}) =>
  renderToStaticMarkup(await NewBookingScreen({ searchParams: Promise.resolve(query) }));

async function aRestaurant() {
  const { restaurantId } = await bookableRestaurant(owner.db, {
    tables: [{ capacity: 2, label: "Window" }, { capacity: 4, label: "Bar", bookable: false }],
  });
  session.tenant = { restaurantId, staffId: crypto.randomUUID(), role: "staff" };
}

describe("add booking", () => {
  it("starts with a GET form for the party and date, and no details form yet", async () => {
    await aRestaurant();
    const html = await render();
    expect(html).toMatch(/<form[^>]*action="\/dashboard\/bookings\/new"[^>]*method="get"/);
    expect(html).not.toContain('name="name"');
  });

  it("then posts the details, so no name or phone reaches a URL, with the phone optional and every table pickable", async () => {
    await aRestaurant();

    const html = await render({ party: "2", date: soon });

    expect(html).toMatch(/<form[^>]*action="\/api\/bookings"[^>]*method="post"/);
    expect(html).toContain('value="18:00"');
    expect(html).toContain("21:00");
    expect(html).toContain("Window (seats 2)");
    expect(html).toContain("Bar (seats 4, walk-ins)");
    expect(html).toContain("Phone (optional)");
    expect(html).not.toMatch(/<input[^>]*name="phone"[^>]*required/);
  });

  it("a crafted party or date shows the first step again, not an error", async () => {
    await aRestaurant();
    for (const query of [{ party: "0", date: soon }, { party: "2", date: "9999-12-31" }, { party: "2", date: "2026-02-31" }, { party: "x\0", date: soon }]) {
      expect(await render(query)).not.toContain('name="name"');
    }
  });

  it("explains a past date in the URL, and offers no details form", async () => {
    await aRestaurant();
    const gone = addDays(localToday(new Date(), "Africa/Harare"), -2);

    const html = await render({ party: "2", date: gone });

    expect(html).toContain("has passed, so a booking can&#x27;t be added to it");
    expect(html).not.toContain('name="name"');
    expect(html).toContain(`href="/dashboard/bookings?date=${gone}"`);
  });

  it("says a day is closed, with the reason, instead of blaming service periods", async () => {
    await aRestaurant();
    const { restaurantId } = session.tenant as TenantContext;
    await owner.db.insert(closures).values({
      restaurantId,
      startsAt: instantOf(soon, "00:00", "Africa/Harare"),
      endsAt: instantOf(addDays(soon, 1), "00:00", "Africa/Harare"),
      reason: "Staff holiday",
    });

    const html = await render({ party: "2", date: soon });

    expect(html).toContain("The restaurant is closed on that day.");
    expect(html).toContain("Staff holiday");
    expect(html).not.toContain("no service period");
    expect(html).not.toContain('name="name"');
  });

  const close = (from: string, to: string, reason: string) =>
    owner.db.insert(closures).values({
      restaurantId: (session.tenant as TenantContext).restaurantId,
      startsAt: instantOf(soon, from, "Africa/Harare"),
      endsAt: to === "24:00" ? instantOf(addDays(soon, 1), "00:00", "Africa/Harare") : instantOf(soon, to, "Africa/Harare"),
      reason,
    });

  it("says a day is closed before a party is chosen", async () => {
    await aRestaurant();
    await close("00:00", "24:00", "Staff holiday");

    const html = await render({ date: soon });

    expect(html).toContain("The restaurant is closed on that day.");
    expect(html).toContain("Staff holiday");
  });

  it("shows the closure that takes every time, though it isn't the whole day", async () => {
    await aRestaurant();
    await close("12:00", "23:00", "Private event");

    const html = await render({ party: "2", date: soon });

    expect(html).toContain("There are no times on that day, and the restaurant is closed for part of it.");
    expect(html).toContain("12:00 to 23:00");
    expect(html).toContain("Private event");
    expect(html).not.toContain("no service period");
    expect(html).not.toContain('name="name"');
  });

  it("counts closures that meet as closing the whole day", async () => {
    await aRestaurant();
    await close("00:00", "15:00", "Morning");
    await close("15:00", "24:00", "Evening");

    const html = await render({ party: "2", date: soon });

    expect(html).toContain("The restaurant is closed on that day.");
    expect(html).toContain("Morning");
    expect(html).toContain("Evening");
    expect(html).not.toContain("no service period");
  });

  it("a closure that leaves times says nothing in their place", async () => {
    await aRestaurant();
    await close("09:00", "10:00", "Delivery");

    const html = await render({ party: "2", date: soon });

    expect(html).toContain('name="name"');
    expect(html).not.toContain("Delivery");
  });
});
