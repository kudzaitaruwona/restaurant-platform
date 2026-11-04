import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bookings, servicePeriods } from "@/db/schema";
import { aBooking, bookableRestaurant } from "../../test/integration/bookings";
import { openOwnerDatabase, testDatabaseSettings } from "../../test/integration/database";
import { getBookingMetrics } from "./booking-metrics";
import { seatWalkIn } from "./walk-in";

/**
 * The success metrics (spec 04), against real rows as app_tenant, on restaurants of
 * their own. Dinner is 18:00 to 23:00 every day unless a test says otherwise, and
 * the zone is Africa/Harare (UTC+2, no daylight saving), so a clock read in UTC
 * is two hours off from the one these tests mean.
 */
const owner = openOwnerDatabase();

beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});
afterAll(async () => {
  await owner.pool.end();
  vi.unstubAllEnvs();
});

// One booking per table, so none collides with another whatever its status.
const tables = Array.from({ length: 12 }, () => ({ capacity: 2 }));

async function restaurant(options: Parameters<typeof bookableRestaurant>[1] = {}) {
  const made = await bookableRestaurant(owner.db, { tables, ...options });
  let next = 0;
  /** Adds a booking made at `createdAt` (an instant), on a table not yet used. */
  const book = async (
    createdAt: string,
    extra: Partial<typeof bookings.$inferInsert> = {},
  ) => {
    const startsAt = new Date(Date.UTC(2027, 0, 10, 16, 0, 0));
    await owner.db.insert(bookings).values({
      ...aBooking(made.restaurantId, made.tableIds[next++], startsAt.toISOString(), new Date(startsAt.getTime() + 105 * 60_000).toISOString()),
      createdAt: new Date(createdAt),
      ...extra,
    });
  };
  return { ...made, tenant: { restaurantId: made.restaurantId }, book };
}

// 17:00 UTC is 19:00 in Harare: inside dinner, though 17:00 would be before it on a UTC clock.
const DURING = "2026-11-05T17:00:00Z";
const AFTER_HOURS = "2026-11-05T03:00:00Z";

describe("how many bookings are made online and how many staff add", () => {
  it("is nothing, and no shares, for a restaurant with no bookings", async () => {
    const { tenant } = await restaurant();

    expect(await getBookingMetrics(tenant)).toEqual({
      online: 0,
      staff: 0,
      onlineShare: null,
      outsideHours: 0,
      noShows: 0,
      attended: 0,
      noShowRate: null,
    });
  });

  it("gives the share made online among online and staff-added bookings", async () => {
    const { tenant, book } = await restaurant();
    await book(DURING);
    await book(DURING);
    await book(DURING);
    await book(DURING, { source: "staff" });

    expect(await getBookingMetrics(tenant)).toMatchObject({
      online: 3,
      staff: 1,
      onlineShare: 0.75,
    });
  });

  it("leaves a walk-in out: staff seated a party, they didn't take a booking", async () => {
    const { tenant, book } = await restaurant();
    await book(DURING);
    await book(DURING, {
      source: "staff",
      status: "seated",
      guestName: "Walk-in",
      guestPhone: null,
      whatsappOptIn: false,
    });

    expect(await getBookingMetrics(tenant)).toMatchObject({
      online: 1,
      staff: 0,
      onlineShare: 1,
      attended: 0,
    });
  });
});

describe("a walk-in seated through seatWalkIn", () => {
  it("is in none of the numbers, whatever label seatWalkIn gives it", async () => {
    const { restaurantId, tenant, tableIds, book } = await restaurant();
    await book(DURING);
    const outcome = await seatWalkIn({ restaurantId, staffId: crypto.randomUUID() }, tableIds[11], 2);
    expect(outcome.outcome).toBe("seated");

    expect(await getBookingMetrics(tenant)).toMatchObject({
      online: 1,
      staff: 0,
      onlineShare: 1,
      attended: 0,
    });
  });
});

describe("online bookings made while staff weren't answering", () => {
  it("counts an online booking made before the first period opens or after the last closes", async () => {
    const { tenant, book } = await restaurant();
    await book(DURING);
    await book(AFTER_HOURS);
    await book("2026-11-05T22:00:00Z");

    expect(await getBookingMetrics(tenant)).toMatchObject({ online: 3, outsideHours: 2 });
  });

  it("reads the boundary on the restaurant's clock: opens_at is inside, closes_at is outside", async () => {
    const { tenant, book } = await restaurant();
    // Local 17:59:59, 18:00:00, 22:59:59 and 23:00:00. The first and last are out.
    await book("2026-11-05T15:59:59Z");
    await book("2026-11-05T16:00:00Z");
    await book("2026-11-05T20:59:59Z");
    await book("2026-11-05T21:00:00Z");

    expect(await getBookingMetrics(tenant)).toMatchObject({ online: 4, outsideHours: 2 });
  });

  it("is not fooled by the server's zone: 17:00 UTC is 19:00 in Harare and inside dinner", async () => {
    const { tenant, book } = await restaurant();
    await book("2026-11-05T17:00:00Z");
    // 18:00 UTC is 20:00 local, also inside; 23:00 UTC is 01:00 local, outside.
    await book("2026-11-05T18:00:00Z");
    await book("2026-11-05T23:00:00Z");

    expect(await getBookingMetrics(tenant)).toMatchObject({ outsideHours: 1 });
  });

  it("uses the local weekday, not the UTC one, across midnight", async () => {
    const { restaurantId, tenant, book } = await restaurant();
    // Only Monday has a period, 01:00 to 03:00 (local).
    await owner.db.delete(servicePeriods).where(sql`${servicePeriods.restaurantId} = ${restaurantId}`);
    await owner.db.insert(servicePeriods).values({
      restaurantId,
      name: "Night",
      weekday: 1,
      opensAt: "01:00",
      lastBookingAt: "02:00",
      closesAt: "03:00",
    });
    // Sunday 23:30 UTC is Monday 01:30 in Harare: inside. Monday 23:30 UTC is
    // Tuesday 01:30 there, which has no period: outside.
    await book("2026-11-08T23:30:00Z");
    await book("2026-11-09T23:30:00Z");

    expect(await getBookingMetrics(tenant)).toMatchObject({ online: 2, outsideHours: 1 });
  });

  it("reads another restaurant's clock when its zone differs", async () => {
    const { tenant, book } = await restaurant({ timezone: "America/New_York" });
    // 23:30 UTC on 5 Nov is 18:30 EST: inside. 03:00 UTC is 22:00 the evening
    // before, also inside; 12:00 UTC is 07:00, outside.
    await book("2026-11-05T23:30:00Z");
    await book("2026-11-05T03:00:00Z");
    await book("2026-11-05T12:00:00Z");

    expect(await getBookingMetrics(tenant)).toMatchObject({ outsideHours: 1 });
  });

  it("is inside when any one of several periods holds the time", async () => {
    const { restaurantId, tenant, book } = await restaurant();
    await owner.db.insert(servicePeriods).values(
      [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        restaurantId,
        name: "Lunch",
        weekday,
        opensAt: "12:00",
        lastBookingAt: "13:30",
        closesAt: "15:00",
      })),
    );
    await book("2026-11-05T11:00:00Z"); // 13:00 local: lunch
    await book("2026-11-05T14:00:00Z"); // 16:00 local: between periods

    expect(await getBookingMetrics(tenant)).toMatchObject({ outsideHours: 1 });
  });

  it("counts every online booking when the restaurant has no periods", async () => {
    const { restaurantId, tenant, book } = await restaurant();
    await owner.db.delete(servicePeriods).where(sql`${servicePeriods.restaurantId} = ${restaurantId}`);
    await book(DURING);

    expect(await getBookingMetrics(tenant)).toMatchObject({ outsideHours: 1 });
  });

  it("only counts online bookings: staff add them at any hour", async () => {
    const { tenant, book } = await restaurant();
    await book(AFTER_HOURS, { source: "staff" });

    expect(await getBookingMetrics(tenant)).toMatchObject({ staff: 1, outsideHours: 0 });
  });

  it("still counts one that was cancelled afterwards: it was made", async () => {
    const { tenant, book } = await restaurant();
    await book(AFTER_HOURS, { status: "cancelled" });

    expect(await getBookingMetrics(tenant)).toMatchObject({ outsideHours: 1 });
  });
});

describe("the no-show rate", () => {
  it("is no-shows among the bookings whose guests were expected: seated, completed and no-show", async () => {
    const { tenant, book } = await restaurant();
    await book(DURING, { status: "no_show" });
    await book(DURING, { status: "completed" });
    await book(DURING, { status: "seated" });
    await book(DURING, { status: "completed", source: "staff" });
    // Not counted either way: told us they weren't coming, or not yet known.
    await book(DURING, { status: "cancelled" });
    await book(DURING, { status: "confirmed" });

    expect(await getBookingMetrics(tenant)).toMatchObject({
      noShows: 1,
      attended: 4,
      noShowRate: 0.25,
    });
  });

  it("is null, not zero, until a booking has an outcome", async () => {
    const { tenant, book } = await restaurant();
    await book(DURING, { status: "cancelled" });
    await book(DURING);

    expect(await getBookingMetrics(tenant)).toMatchObject({ noShows: 0, attended: 0, noShowRate: null });
  });

  it("does not count walk-ins, who can't fail to show", async () => {
    const { tenant, book } = await restaurant();
    await book(DURING, { status: "no_show" });
    await book(DURING, {
      source: "staff",
      status: "completed",
      guestName: "Walk-in",
      guestPhone: null,
      whatsappOptIn: false,
    });

    expect(await getBookingMetrics(tenant)).toMatchObject({ noShowRate: 1 });
  });
});

describe("one restaurant's numbers", () => {
  it("never include another restaurant's bookings", async () => {
    const a = await restaurant();
    const b = await restaurant();
    await a.book(DURING);
    await b.book(AFTER_HOURS, { status: "no_show" });
    await b.book(AFTER_HOURS, { source: "staff" });

    expect(await getBookingMetrics(a.tenant)).toMatchObject({
      online: 1,
      staff: 0,
      outsideHours: 0,
      noShows: 0,
    });
  });

  it("are zeros when asked for under another restaurant's id: RLS hides its rows", async () => {
    const a = await restaurant();
    const b = await restaurant();
    await b.book(AFTER_HOURS);

    const { rows } = await (await import("@/lib/tenant/scope")).withTenant(a.tenant, (tx) =>
      tx.execute(sql`select * from booking_success_metrics(${b.restaurantId})`),
    );

    expect(rows).toEqual([{ online: 0, staff: 0, outside_hours: 0, no_shows: 0, attended: 0 }]);
  });
});
