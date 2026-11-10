import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bookings, notifications } from "@/db/schema";
import { aBooking, bookableRestaurant } from "../../../test/integration/bookings";
import { openOwnerDatabase, openSystemDatabase, testDatabaseSettings } from "../../../test/integration/database";
import { completeOverdueSittings, markNoShows } from "./booking-status";

/**
 * The reminder and the job's own status changes (#45): the no-show and completion
 * tasks make the booking's pending reminder `cancelled`. Sending the reminder is
 * tested in notifications.int.test.ts, whose years the outbox's runs are kept to.
 * These two tasks look across every restaurant, so they run in 1989, earlier than
 * any booking another file makes them touch.
 */
const owner = openOwnerDatabase();
const system = openSystemDatabase();
beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});
afterAll(async () => {
  await Promise.all([owner.pool.end(), system.pool.end()]);
  vi.unstubAllEnvs();
});

const HOUR = 3_600_000;

/** A booking starting at `startsAt` with a pending reminder. */
async function withReminder(startsAt: string, status: typeof bookings.$inferSelect.status = "confirmed") {
  const { restaurantId, tableIds } = await bookableRestaurant(owner.db);
  const start = new Date(startsAt);
  const [booking] = await owner.db
    .insert(bookings)
    .values({
      ...aBooking(restaurantId, tableIds[0], startsAt, new Date(start.getTime() + 2 * HOUR).toISOString()),
      endsAt: new Date(start.getTime() + 90 * 60_000),
      guestName: "Tariro Moyo",
      guestPhone: "+263779876543",
      partySize: 4,
      status,
    })
    .returning({ id: bookings.id, manageToken: bookings.manageToken });
  const [reminder] = await owner.db
    .insert(notifications)
    .values({
      restaurantId,
      bookingId: booking.id,
      kind: "booking_reminder",
      // Far in the future, not starts_at - 3h: no outbox run in another file's years may claim it.
      scheduledFor: new Date("2200-01-01T00:00:00Z"),
    })
    .returning({ id: notifications.id });
  return { restaurantId, ...booking, reminderId: reminder.id, start };
}

const statusOf = async (id: string) =>
  (await owner.db.select({ status: notifications.status }).from(notifications).where(eq(notifications.id, id)))[0]
    .status;

describe("the job's own status changes", () => {
  it("markNoShows cancels the pending reminder of the booking it marks", async () => {
    const { reminderId, id } = await withReminder("1989-02-01T17:00:00Z");

    await markNoShows(system.db, new Date("1989-02-01T19:00:00Z"));

    expect((await owner.db.select().from(bookings).where(eq(bookings.id, id)))[0].status).toBe("no_show");
    expect(await statusOf(reminderId)).toBe("cancelled");
  });

  it("completeOverdueSittings cancels the pending reminder of the booking it completes", async () => {
    const { reminderId, id } = await withReminder("1989-03-01T17:00:00Z", "seated");

    await completeOverdueSittings(system.db, new Date("1989-03-01T20:00:00Z"));

    expect((await owner.db.select().from(bookings).where(eq(bookings.id, id)))[0].status).toBe("completed");
    expect(await statusOf(reminderId)).toBe("cancelled");
  });
});
