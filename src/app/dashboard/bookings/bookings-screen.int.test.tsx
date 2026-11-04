import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { bookings, diningTables } from "@/db/schema";
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

    // Move is there because the no-show freed the third table.
    expect(actionsOf("Waiting")).toEqual(["seat", "no-show", "cancel", "move"]);
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

  it("offers Add booking, for the day being looked at", async () => {
    await dayWith([]);
    const html = await render(day);
    expect(html).toContain(`href="/dashboard/bookings/new?date=${day}"`);
    expect(html).toContain("Add booking");
  });

  it("offers Move table on a confirmed booking only, with just the tables free for its hold", async () => {
    // Waiting is on table 1; Eating holds table 2; Gone's no-show frees table 3.
    await dayWith([{ guestName: "Waiting" }, { guestName: "Eating", status: "seated" }, { guestName: "Gone", status: "no_show" }]);

    const html = await render(day);
    const row = (name: string) => html.split("<li").find((part) => part.includes(name)) ?? "";

    const options = [...row("Waiting").matchAll(/<option value="[0-9a-f-]+">([^<]*)</g)].map((m) => m[1]);
    expect(options).toHaveLength(1);
    expect(options[0]).toMatch(/^T3 \(seats 4/);
    expect(row("Waiting")).toContain('name="tableId"');
    expect(row("Eating")).not.toContain("tableId");
    expect(row("Gone")).not.toContain("tableId");
  });

  it("says so when no other table is free", async () => {
    await dayWith([{ guestName: "Alone" }]);
    const html = await render(day);
    expect(html).toContain("No other table is free");
    expect(html).not.toContain('name="tableId"');
  });
});

describe("seat walk-in on the day view", () => {
  const today = localToday(new Date(), "Africa/Harare");

  it("is offered today, with the live tables, walk-in-only ones included, and posts to the walk-in route", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 2, label: "Table 7" }, { capacity: 4, label: "Bar", bookable: false }],
    });
    session.tenant = { restaurantId, staffId: crypto.randomUUID(), role: "staff" };

    const html = await render();

    expect(html).toContain("Seat a walk-in");
    expect(html).toContain('action="/api/bookings/walk-in"');
    expect(html).toContain('method="post"');
    expect(html).toContain("Table 7 (seats 2)");
    expect(html).toContain("Bar (seats 4)");
    expect(html).toContain('name="party"');
  });

  it("is not offered on another day: a walk-in sits down now", async () => {
    await dayWith([]);

    expect(await render(addDays(today, 1))).not.toContain("Seat a walk-in");
  });

  it("is not offered when there is no live table to seat at", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, { tables: [{ capacity: 2 }] });
    session.tenant = { restaurantId, staffId: crypto.randomUUID(), role: "staff" };
    await owner.db.update(diningTables).set({ archivedAt: new Date() }).where(eq(diningTables.id, tableIds[0]));

    expect(await render()).not.toContain("Seat a walk-in");
  });

  it("today shows Add booking, a confirmed booking's Move select and the walk-in form together; another day has no walk-in form", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, { tables: [{ capacity: 4 }, { capacity: 4 }] });
    session.tenant = { restaurantId, staffId: crypto.randomUUID(), role: "staff" };
    await owner.db.insert(bookings).values({
      ...aBooking(restaurantId, tableIds[0], `${today}T10:00:00Z`, `${today}T11:45:00Z`),
      guestName: "Waiting",
    });

    const html = await render();
    expect(html).toContain(`href="/dashboard/bookings/new?date=${today}"`);
    expect(html).toContain("Seat a walk-in");
    expect(html.split("<li").find((part) => part.includes("Waiting"))).toContain('name="tableId"');

    const other = await render(addDays(today, 1));
    expect(other).toContain("Add booking");
    expect(other).not.toContain("Seat a walk-in");
  });

  it("shows a walk-in's row as a seated 'Walk-in' with no contact buttons, at the restaurant's time", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, { tables: [{ capacity: 2 }] });
    session.tenant = { restaurantId, staffId: crypto.randomUUID(), role: "staff" };
    await owner.db.insert(bookings).values({
      ...aBooking(restaurantId, tableIds[0], `${today}T10:00:00Z`, `${today}T11:45:00Z`),
      guestName: "Walk-in",
      guestPhone: null,
      whatsappOptIn: false,
      status: "seated",
      source: "staff",
    });

    const html = await render();

    expect(html).toContain("Walk-in");
    expect(html).toContain("12:00");
    expect(html).toContain("Finish");
    expect(html).not.toContain("tel:");
  });
});
