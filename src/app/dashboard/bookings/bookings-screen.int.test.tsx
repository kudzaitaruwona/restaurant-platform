import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { bookings, closures, diningTables, notifications } from "@/db/schema";
import { addDays, instantOf, localToday } from "@/lib/booking-engine";
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
      const row = html.split(/<li[\s>]/).find((part) => part.includes(name)) ?? "";
      return [...row.matchAll(/<form[^>]*action="\/api\/bookings\/[0-9a-f-]+\/([a-z-]+)"[^>]*method="post"/g)].map((m) => m[1]);
    };

    // Move is there because the no-show freed the third table.
    expect(actionsOf("Waiting")).toEqual(["seat", "no-show", "cancel", "move"]);
    expect(actionsOf("Eating")).toEqual(["finish"]);
    expect(actionsOf("Gone")).toEqual([]);
  });

  it("keeps Seat in the row and puts No-show and Cancel in its More menu, each submitting its own form", async () => {
    await dayWith([{ guestName: "Waiting" }]);

    const row = (await render(day)).split(/<li[\s>]/).find((part) => part.includes("Waiting")) ?? "";
    const menu = row.slice(row.indexOf('role="menu"'));

    expect(row).toContain('aria-label="More for Waiting"');
    expect(row.indexOf("/seat")).toBeLessThan(row.indexOf('role="menu"'));
    for (const action of ["no-show", "cancel"]) {
      const id = new RegExp(`<form id="([^"]+)"[^>]*action="/api/bookings/[0-9a-f-]+/${action}"`).exec(row)?.[1];
      expect(id).toBeDefined();
      expect(menu).toMatch(new RegExp(`role="menuitem" type="submit" form="${id}"`));
    }
  });

  it("warns in the Cancel dialog that the guest is messaged, only when they will be", async () => {
    await dayWith([
      { guestName: "Reachable", guestPhone: "+263771234567", whatsappOptIn: true },
      { guestName: "Optedout", guestPhone: "+263771234568", whatsappOptIn: false },
      { guestName: "Numberless", guestPhone: null, whatsappOptIn: true },
    ]);

    const html = await render(day);
    const dialogOf = (name: string, action: string) => {
      const row = html.split(/<li[\s>]/).find((part) => part.includes(name)) ?? "";
      const form = row.slice(row.indexOf(`/${action}"`));
      return form.slice(0, form.indexOf("</dialog>"));
    };

    expect(dialogOf("Reachable", "cancel")).toContain("message them on WhatsApp to say it");
    expect(dialogOf("Reachable", "no-show")).not.toContain("WhatsApp");
    expect(dialogOf("Optedout", "cancel")).not.toContain("WhatsApp");
    expect(dialogOf("Numberless", "cancel")).not.toContain("WhatsApp");
  });

  it("says where each booking came from: online, or added by staff", async () => {
    await dayWith([{ guestName: "Booked", source: "online" }, { guestName: "Phoned", source: "staff" }]);

    const html = await render(day);
    const row = (name: string) => html.split(/<li[\s>]/).find((part) => part.includes(name)) ?? "";

    expect(row("Booked")).toContain("Online");
    expect(row("Booked")).not.toContain("Added by staff");
    expect(row("Phoned")).toContain("Added by staff");
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

  it("never breaks the Today pill beside the date (#94)", async () => {
    await dayWith([]);
    const pill = /<span class="([^"]*)">Today<\/span>/.exec(await render())![1].split(" ");
    expect(pill).toEqual(expect.arrayContaining(["shrink-0", "whitespace-nowrap"]));
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
    const row = (name: string) => html.split(/<li[\s>]/).find((part) => part.includes(name)) ?? "";

    // The move dialog lists them as radio rows: the table, then what it seats.
    const options = [
      ...row("Waiting").matchAll(/<input type="radio"[^>]*name="tableId"[^>]*value="[0-9a-f-]+"[^>]*\/><span[^>]*>([^<]*)<\/span><span[^>]*>([^<]*)</g),
    ].map((m) => `${m[1]} ${m[2]}`);
    expect(options).toEqual(["T3 seats 4"]);
    expect(row("Waiting")).toMatch(/<form[^>]*action="\/api\/bookings\/[0-9a-f-]+\/move"[^>]*method="post"/);
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

describe("a confirmation that failed to deliver (spec 05, Delivery status)", () => {
  type NotificationStatus = (typeof notifications.$inferSelect)["status"];

  /** One booking per entry, each with its booking_confirmed in the given status (or none). */
  async function dayWithConfirmations(rows: { guestName: string; status?: "confirmed" | "seated"; confirmation?: NotificationStatus }[]) {
    // A number each: one number may hold only so many upcoming bookings.
    await dayWith(rows.map(({ guestName, status = "confirmed" }, index) => ({ guestName, status, guestPhone: `+26377123456${index}` })));
    const restaurantId = (session.tenant as TenantContext).restaurantId;
    const ours = await owner.db.select({ id: bookings.id, guestName: bookings.guestName }).from(bookings).where(eq(bookings.restaurantId, restaurantId));
    const queued = rows.flatMap(({ guestName, confirmation }) => {
      const booking = ours.find((row) => row.guestName === guestName)!;
      return confirmation
        ? [{ restaurantId, bookingId: booking.id, kind: "booking_confirmed" as const, scheduledFor: new Date(), status: confirmation, claimedAt: new Date() }]
        : [];
    });
    if (queued.length > 0) await owner.db.insert(notifications).values(queued);
  }
  const rowOf = (html: string, name: string) => html.split(/<li[\s>]/).find((part) => part.includes(name)) ?? "";
  const WARNING = "WhatsApp confirmation failed";

  it("shows a warning on the booking, which stays confirmed with every action", async () => {
    await dayWithConfirmations([{ guestName: "Unreached", confirmation: "failed" }]);

    const row = rowOf(await render(day), "Unreached");

    expect(row).toContain(WARNING);
    expect(row).toMatch(/role="img"[^>]*aria-label="WhatsApp confirmation failed: call the guest"/);
    expect(row).toContain("Confirmed");
    expect(row).toContain("/seat");
    expect(row).toContain('href="tel:+263771234560"');
  });

  it("shows none for a confirmation sent, delivered, read, still queued, or never queued", async () => {
    await dayWithConfirmations([
      { guestName: "Sent", confirmation: "sent" },
      { guestName: "Delivered", confirmation: "delivered" },
      { guestName: "Read", confirmation: "read" },
      { guestName: "Queued", confirmation: "pending" },
      { guestName: "Cancelled", confirmation: "cancelled" },
      { guestName: "Nothing" },
    ]);

    expect(await render(day)).not.toContain(WARNING);
  });

  it("shows none once the guest is seated: they are here", async () => {
    await dayWithConfirmations([{ guestName: "Arrived", status: "seated", confirmation: "failed" }]);

    expect(await render(day)).not.toContain(WARNING);
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
    expect(html).toContain("Table 7 (seats 2), free");
    expect(html).toContain("Bar (seats 4), free");
    expect(html).toContain('name="party"');
  });

  it("says which tables are free, in use, being reset or have a booking too soon, leaves every one to the server and chooses none for staff", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 2, label: "Free" }, { capacity: 2, label: "Busy" }, { capacity: 2, label: "Reset" }, { capacity: 2, label: "Soon" }],
    });
    session.tenant = { restaurantId, staffId: crypto.randomUUID(), role: "staff" };
    const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();
    await owner.db.insert(bookings).values([
      { ...aBooking(restaurantId, tableIds[1], minutes(-30), minutes(75)), status: "seated" },
      { ...aBooking(restaurantId, tableIds[2], minutes(-60), minutes(45)), status: "completed", endsAt: new Date(minutes(-5)) },
      aBooking(restaurantId, tableIds[3], minutes(20), minutes(125)),
    ]);

    const html = await render();

    expect(html).toContain("Choose a table");
    expect(html.match(/<option[^>]*selected[^>]*>[^<]*/g)).toEqual([expect.stringContaining("Choose a table")]);
    // A list gone stale never overrules the server: a disabled option would post no table,
    // and the placeholder is what the select falls back to if the chosen table goes.
    const select = html.match(/<select[^>]*name="tableId"[^>]*required.*?<\/select>/)?.[0] ?? "";
    expect(select).not.toContain('disabled=""');
    expect(select).toMatch(/>Free \(seats 2\), free</);
    expect(select).toMatch(/>Busy \(seats 2\), in use until \d\d:\d\d</);
    expect(select).toMatch(/>Reset \(seats 2\), being reset until \d\d:\d\d</);
    expect(select).toMatch(/>Soon \(seats 2\), booking at \d\d:\d\d, too soon</);
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
    expect(html.split(/<li[\s>]/).find((part) => part.includes("Waiting"))).toContain('name="tableId"');

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

describe("closed and past days (#108)", () => {
  const today = localToday(new Date(), "Africa/Harare");
  const wholeDay = (restaurantId: string, date: string, reason: string | null) =>
    owner.db.insert(closures).values({
      restaurantId,
      startsAt: instantOf(date, "00:00", "Africa/Harare"),
      endsAt: instantOf(addDays(date, 1), "00:00", "Africa/Harare"),
      reason,
    });

  it("shows a closed day's closure and reason, and offers no Add booking", async () => {
    await dayWith([]);
    await wholeDay((session.tenant as TenantContext).restaurantId, day, "Independence Day <b>");

    const html = await render(day);

    expect(html).toContain("The restaurant is closed on this day.");
    expect(html).toContain("Independence Day &lt;b&gt;");
    expect(html).not.toContain("Add booking");
    expect(html).not.toContain("/dashboard/bookings/new");
  });

  it("shows part of a day's closure with its times, and still offers Add booking", async () => {
    await dayWith([]);
    await owner.db.insert(closures).values({
      restaurantId: (session.tenant as TenantContext).restaurantId,
      startsAt: instantOf(day, "19:00", "Africa/Harare"),
      endsAt: instantOf(day, "22:00", "Africa/Harare"),
      reason: "Private event",
    });

    const html = await render(day);

    expect(html).toContain("closed for part of this day");
    expect(html).toContain("19:00 to 22:00");
    expect(html).toContain("Private event");
    expect(html).toContain("Add booking");
  });

  it("shows a closure only on the days it touches", async () => {
    await dayWith([]);
    await wholeDay((session.tenant as TenantContext).restaurantId, day, "Away");

    expect(await render(addDays(day, 1))).not.toContain("closed");
    expect(await render(addDays(day, 1))).toContain("Add booking");
  });

  it("offers no Add booking on a past day, and says why; today and later days do", async () => {
    await dayWith([]);

    const past = await render(addDays(today, -2));

    expect(past).toContain("This day has passed, so bookings can&#x27;t be added to it.");
    expect(past).not.toContain("Add booking");
    expect(past).not.toContain("/dashboard/bookings/new");
    expect(await render()).toContain("Add booking");
    expect(await render(addDays(today, 1))).toContain("Add booking");
    expect(await render()).not.toContain("has passed");
  });

  it("gives each booking row an anchor the conflict list links to", async () => {
    await dayWith([{ guestName: "Tariro" }]);
    const [{ id }] = await owner.db
      .select({ id: bookings.id })
      .from(bookings)
      .where(eq(bookings.restaurantId, (session.tenant as TenantContext).restaurantId));

    expect(await render(day)).toContain(`id="booking-${id}"`);
  });

  it("names the year unless it is this year's, in the heading", async () => {
    await dayWith([]);
    const heading = async (date?: string) => /<h2[^>]*>([^<]*)<\/h2>/.exec(await render(date))?.[1];
    const thisYear = today.slice(0, 4);

    expect(await heading(today)).not.toMatch(/\d{4}/);
    expect(await heading(day)).toMatch(day.startsWith(thisYear) ? /^[A-Za-z]+ \d+ [A-Za-z]+$/ : /\d{4}$/);
    for (const date of [addDays(today, 366), addDays(today, -366)]) {
      expect(await heading(date)).toContain(date.slice(0, 4));
    }
  });

  it("lets the heading wrap rather than cut it off", async () => {
    await dayWith([]);
    const html = await render(day);
    const h2 = /<h2[^>]*>/.exec(html)?.[0] ?? "";
    expect(h2).not.toContain("truncate");
  });
});
