import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { bookings } from "@/db/schema";
import { aBooking, bookableRestaurant } from "../../../test/integration/bookings";
import { openOwnerDatabase, openSystemDatabase } from "../../../test/integration/database";
import { purgeGuestPhones } from "./phone-purge";

/**
 * D-06 (proposed): the scheduled job nulls a booking's phone number 30 days
 * after the booking date, and keeps the name and the outcome. The date is the
 * booking's own day in restaurants.timezone, so the number goes at the local
 * midnight that starts day booking_date + 30: not at a UTC midnight, and not
 * 30 x 24 hours after the start. Like the other job tests this picks its own
 * "now" and lives in a year no other file uses. It is 1991, not 1990: the status
 * rules' tests sweep every confirmed booking in 1990, and this file makes some.
 */
const owner = openOwnerDatabase();
const system = openSystemDatabase();
afterAll(() => Promise.all([owner.pool.end(), system.pool.end()]));

const PHONE = "+263771234567";
const at = (iso: string) => new Date(iso);

type Status = typeof bookings.$inferSelect["status"];

/** A booking starting at `startsAt` (an ISO instant), an hour long, with a phone. */
async function aBookingWithPhone(
  restaurantId: string,
  tableId: string,
  startsAt: string,
  { status = "completed", phone = PHONE as string | null }: { status?: Status; phone?: string | null } = {},
) {
  const start = new Date(startsAt);
  const [row] = await owner.db
    .insert(bookings)
    .values({
      ...aBooking(restaurantId, tableId, startsAt, new Date(start.getTime() + 3_600_000).toISOString()),
      guestName: "Tariro Moyo",
      guestPhone: phone,
      guestNote: "Window seat",
      status,
    })
    .returning({ id: bookings.id });
  return row.id;
}

const row = async (id: string) => {
  const [found] = await owner.db.select().from(bookings).where(eq(bookings.id, id));
  return found;
};

describe("a booking's phone number", () => {
  it("is nulled once 30 days have passed since the booking date, keeping the name, the outcome and the rest", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, { tables: [{ capacity: 4 }] });
    const id = await aBookingWithPhone(restaurantId, tableIds[0], "1991-05-02T17:00:00Z", { status: "no_show" });
    const before = await row(id);

    expect(await purgeGuestPhones(system.db, at("1991-06-05T12:00:00Z"))).toBeGreaterThanOrEqual(1);

    expect(await row(id)).toEqual({ ...before, guestPhone: null });
    expect(before.guestPhone).toBe(PHONE);
  });

  it("is kept until the local midnight that starts day booking date + 30, and nulled at it (Harare)", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 4 }, { capacity: 4 }],
      timezone: "Africa/Harare",
    });
    // 00:30 on 2 May in Harare is 22:30 UTC on 1 May: the UTC date is a day earlier.
    const early = await aBookingWithPhone(restaurantId, tableIds[0], "1991-05-01T22:30:00Z");
    // 23:30 on 2 May in Harare, the last half hour of the same local day.
    const late = await aBookingWithPhone(restaurantId, tableIds[1], "1991-05-02T21:30:00Z");

    // Local midnight starting 1 June in Harare (UTC+2) is 22:00 UTC on 31 May.
    await purgeGuestPhones(system.db, at("1991-05-31T21:59:59Z"));
    expect((await row(early)).guestPhone).toBe(PHONE);
    expect((await row(late)).guestPhone).toBe(PHONE);

    await purgeGuestPhones(system.db, at("1991-05-31T22:00:00Z"));
    expect((await row(early)).guestPhone).toBeNull();
    expect((await row(late)).guestPhone).toBeNull();
  });

  it("counts the day in the restaurant's zone, not UTC: a booking late on a local evening whose UTC date is the next", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 4 }],
      timezone: "America/New_York",
    });
    // 22:30 on 2 May in New York (UTC-4) is 02:30 UTC on 3 May.
    const id = await aBookingWithPhone(restaurantId, tableIds[0], "1991-05-03T02:30:00Z");

    // Local midnight starting 1 June in New York is 04:00 UTC on 1 June. By UTC
    // dates the day would be 3 May and the number would go at 00:00 UTC on 2 June.
    await purgeGuestPhones(system.db, at("1991-06-01T03:59:59Z"));
    expect((await row(id)).guestPhone).toBe(PHONE);

    await purgeGuestPhones(system.db, at("1991-06-01T04:00:00Z"));
    expect((await row(id)).guestPhone).toBeNull();
  });

  it("goes by each restaurant's own zone when the job reaches several at one moment", async () => {
    const harare = await bookableRestaurant(owner.db, { tables: [{ capacity: 4 }], timezone: "Africa/Harare" });
    const newYork = await bookableRestaurant(owner.db, { tables: [{ capacity: 4 }], timezone: "America/New_York" });
    // The same instant is 2 May in both zones.
    const a = await aBookingWithPhone(harare.restaurantId, harare.tableIds[0], "1991-05-02T12:00:00Z");
    const b = await aBookingWithPhone(newYork.restaurantId, newYork.tableIds[0], "1991-05-02T12:00:00Z");

    // 22:00 UTC on 31 May: past Harare's 1 June midnight, before New York's.
    await purgeGuestPhones(system.db, at("1991-05-31T22:00:00Z"));
    expect((await row(a)).guestPhone).toBeNull();
    expect((await row(b)).guestPhone).toBe(PHONE);
  });

  it("is nulled whatever the booking's outcome, and a booking with none is left as it is", async () => {
    const statuses = ["confirmed", "seated", "completed", "no_show", "cancelled"] as const;
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, {
      tables: [...statuses, "walk-in"].map(() => ({ capacity: 4 })),
    });
    const ids = await Promise.all(
      statuses.map((status, i) => aBookingWithPhone(restaurantId, tableIds[i], "1991-04-01T17:00:00Z", { status })),
    );
    const walkIn = await aBookingWithPhone(restaurantId, tableIds[5], "1991-04-01T17:00:00Z", {
      status: "completed",
      phone: null,
    });

    await purgeGuestPhones(system.db, at("1991-06-01T12:00:00Z"));

    for (const [i, id] of ids.entries()) {
      expect(await row(id)).toMatchObject({ guestPhone: null, status: statuses[i], guestName: "Tariro Moyo" });
    }
    expect(await row(walkIn)).toMatchObject({ guestPhone: null, status: "completed" });
  });

  it("leaves a booking still inside the 30 days, and an upcoming one, with its number", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, { tables: [{ capacity: 4 }, { capacity: 4 }] });
    const recent = await aBookingWithPhone(restaurantId, tableIds[0], "1991-05-20T17:00:00Z");
    const upcoming = await aBookingWithPhone(restaurantId, tableIds[1], "1991-06-10T17:00:00Z", { status: "confirmed" });

    await purgeGuestPhones(system.db, at("1991-06-01T12:00:00Z"));

    expect((await row(recent)).guestPhone).toBe(PHONE);
    expect((await row(upcoming)).guestPhone).toBe(PHONE);
  });

  it("is nulled once however many runs arrive, together or one after another", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, { tables: [{ capacity: 4 }] });
    const ids = await Promise.all(
      [1, 2, 3, 4].map((day) => aBookingWithPhone(restaurantId, tableIds[0], `1991-04-0${day}T17:00:00Z`)),
    );
    const now = at("1991-06-01T12:00:00Z");

    const counts = await Promise.all([purgeGuestPhones(system.db, now), purgeGuestPhones(system.db, now), purgeGuestPhones(system.db, now)]);
    expect(counts.reduce((sum, n) => sum + n, 0)).toBeGreaterThanOrEqual(4);
    expect(await purgeGuestPhones(system.db, now)).toBe(0);

    for (const id of ids) expect((await row(id)).guestPhone).toBeNull();
  });

  it("takes more than one batch when more than 200 are due", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, { tables: [{ capacity: 4 }] });
    await owner.db.insert(bookings).values(
      Array.from({ length: 205 }, (_, i) => ({
        ...aBooking(
          restaurantId,
          tableIds[0],
          new Date(Date.UTC(1991, 0, 1) + i * 3 * 3_600_000).toISOString(),
          new Date(Date.UTC(1991, 0, 1) + (i * 3 + 1) * 3_600_000).toISOString(),
        ),
        guestPhone: PHONE,
        status: "completed" as const,
      })),
    );

    expect(await purgeGuestPhones(system.db, at("1991-06-01T12:00:00Z"))).toBeGreaterThanOrEqual(205);

    const { rows } = await owner.db.execute<{ left: number }>(
      sql`select count(*)::int as left from bookings where restaurant_id = ${restaurantId} and guest_phone is not null`,
    );
    expect(rows).toEqual([{ left: 0 }]);
  });
});
