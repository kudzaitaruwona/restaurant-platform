import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bookings } from "@/db/schema";
import { addDays, localToday } from "@/lib/booking-engine";
import type { TenantContext } from "@/lib/tenant";
import { aBooking, bookableRestaurant } from "../../../../test/integration/bookings";
import { openOwnerDatabase, testDatabaseSettings } from "../../../../test/integration/database";
import { BookingsScreen } from "./bookings-screen";

/** The day view as markup, on a restaurant of its own. Who's asking is faked: access.int.test.ts has the real seam. */
const session = vi.hoisted(() => ({ tenant: undefined as unknown }));
vi.mock("@/lib/tenant", async (original) => ({
  ...(await original<typeof import("@/lib/tenant")>()),
  getTenantContext: async () => session.tenant as TenantContext,
}));
vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh() {} }),
}));

// Inside the day view's window around today, which the restaurant's zone decides.
const day = addDays(localToday(new Date(), "Africa/Harare"), 5);
const owner = openOwnerDatabase();
beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});
afterAll(async () => {
  await owner.pool.end();
  vi.unstubAllEnvs();
});

const render = async (date?: string) =>
  renderToStaticMarkup(await BookingsScreen({ searchParams: Promise.resolve(date ? { date } : {}) }));

async function dayWith(rows: Partial<typeof bookings.$inferInsert>[]) {
  const { restaurantId, tableIds } = await bookableRestaurant(owner.db, {
    tables: Array.from({ length: Math.max(rows.length, 1) }, () => ({ capacity: 4 })),
  });
  session.tenant = { restaurantId, staffId: crypto.randomUUID(), role: "staff" };
  if (rows.length === 0) return;
  await owner.db.insert(bookings).values(
    rows.map((row, index) => ({
      ...aBooking(restaurantId, tableIds[index], `${day}T17:00:00Z`, `${day}T18:45:00Z`),
      ...row,
    })),
  );
}

describe("the day view", () => {
  it("shows time in the restaurant's zone, the guest, party, status, note and the contact buttons from the stored number", async () => {
    await dayWith([{ guestName: "Tariro", guestPhone: "+263771234567", guestNote: "Window <b>please</b>", partySize: 4 }]);

    const html = await render(day);

    expect(html).toContain("19:00");
    expect(html).toContain("Tariro");
    expect(html).toContain("Party of 4");
    expect(html).toContain("Confirmed");
    expect(html).toContain("Window &lt;b&gt;please&lt;/b&gt;");
    expect(html).toContain('href="tel:+263771234567"');
    expect(html).toContain('href="https://wa.me/263771234567"');
    expect(html).toContain("Dinner");
    expect(html).toContain("1 booking, 4 covers");
  });

  it("offers Seat, No-show and Cancel on a confirmed booking as plain posts, and Finish on a seated one", async () => {
    await dayWith([{ guestName: "Waiting" }, { guestName: "Eating", status: "seated" }, { guestName: "Gone", status: "no_show" }]);

    const html = await render(day);
    const actionsOf = (name: string) => {
      const row = html.split("<li").find((part) => part.includes(name)) ?? "";
      return [...row.matchAll(/<form[^>]*action="\/api\/bookings\/[0-9a-f-]+\/([a-z-]+)"[^>]*method="post"/g)].map((m) => m[1]);
    };

    expect(actionsOf("Waiting")).toEqual(["seat", "no-show", "cancel"]);
    expect(actionsOf("Eating")).toEqual(["finish"]);
    expect(actionsOf("Gone")).toEqual([]);
  });

  it("shows no call buttons for a walk-in with no number", async () => {
    await dayWith([{ guestName: "Walk-in", guestPhone: null }]);
    const html = await render(day);
    expect(html).not.toContain("tel:");
    expect(html).not.toContain("wa.me");
  });

  it("a crafted date shows today with a notice, not an error", async () => {
    await dayWith([]);
    const html = await render("9999-99-99");
    expect(html).toContain("That date wasn&#x27;t usable, so this is today.");
  });

  it("links the neighbouring days and a date picker that is a GET form", async () => {
    await dayWith([]);
    const html = await render(day);
    expect(html).toContain(`/dashboard/bookings?date=${addDays(day, -1)}`);
    expect(html).toContain(`/dashboard/bookings?date=${addDays(day, 1)}`);
    expect(html).toMatch(/<form[^>]*action="\/dashboard\/bookings"[^>]*method="get"/);
  });
});
