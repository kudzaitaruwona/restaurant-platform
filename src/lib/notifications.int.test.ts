import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bookings, notifications } from "@/db/schema";
import { aBooking, bookableRestaurant } from "../../test/integration/bookings";
import { openOwnerDatabase, testDatabaseSettings } from "../../test/integration/database";
import { addStaffBooking, type StaffRequest } from "./booking-staff";
import { confirmBooking, type GuestRequest } from "./bookings";

/**
 * Spec 05's outbox, the queueing half (#44): confirming a booking for a guest who
 * opted in and gave a number queues booking_confirmed, due at once, in the same
 * transaction as the booking, on both paths that confirm one (the guest's online
 * booking and staff adding one). As app_tenant, each test on a restaurant of its own.
 */
const owner = openOwnerDatabase();
beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});
afterAll(async () => {
  await owner.pool.end();
  vi.unstubAllEnvs();
});

// 08:00 on Thursday 5 Nov in Harare; Friday's dinner is clear of the lead time.
const now = new Date("2026-11-05T06:00:00Z");
const date = "2026-11-06";

const guest = (overrides: Partial<GuestRequest> = {}): GuestRequest => ({
  party: 2,
  date,
  time: "19:00",
  name: "Tariro",
  phone: "+263771234567",
  note: null,
  whatsappOptIn: true,
  ...overrides,
});

const staffRequest = (overrides: Partial<StaffRequest> = {}): StaffRequest => ({
  party: 2,
  date,
  time: "19:00",
  tableId: undefined,
  name: "Staff guest",
  phone: "+263771234567",
  note: null,
  whatsappOptIn: true,
  ...overrides,
});

const actor = (restaurantId: string) => ({ restaurantId, staffId: crypto.randomUUID(), role: "staff" as const });

const queuedFor = (restaurantId: string) =>
  owner.db
    .select({
      bookingId: notifications.bookingId,
      kind: notifications.kind,
      channel: notifications.channel,
      status: notifications.status,
      scheduledFor: notifications.scheduledFor,
      attempts: notifications.attempts,
      claimedAt: notifications.claimedAt,
    })
    .from(notifications)
    .where(eq(notifications.restaurantId, restaurantId));

const bookingIdsOf = async (restaurantId: string) =>
  (await owner.db.select({ id: bookings.id }).from(bookings).where(eq(bookings.restaurantId, restaurantId))).map(
    ({ id }) => id,
  );

describe("confirming a booking online", () => {
  it("queues booking_confirmed, due now, for a guest who opted in", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db);

    expect((await confirmBooking({ restaurantId }, guest(), now)).outcome).toBe("confirmed");

    const [bookingId] = await bookingIdsOf(restaurantId);
    // The reminder (#45) is queued beside it: see booking-reminder.int.test.ts.
    expect((await queuedFor(restaurantId)).filter(({ kind }) => kind === "booking_confirmed")).toEqual([
      {
        bookingId,
        kind: "booking_confirmed",
        channel: "whatsapp",
        status: "pending",
        scheduledFor: now,
        attempts: 0,
        claimedAt: null,
      },
    ]);
  });

  it("queues nothing for a guest who didn't opt in", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db);

    expect((await confirmBooking({ restaurantId }, guest({ whatsappOptIn: false }), now)).outcome).toBe("confirmed");

    expect(await bookingIdsOf(restaurantId)).toHaveLength(1);
    expect(await queuedFor(restaurantId)).toEqual([]);
  });

  it("queues nothing when the booking isn't made", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db);
    await owner.db.insert(bookings).values(aBooking(restaurantId, tableIds[0], "2026-11-06T17:00:00Z", "2026-11-06T19:00:00Z"));

    expect((await confirmBooking({ restaurantId }, guest(), now)).outcome).toBe("race_lost");

    expect(await queuedFor(restaurantId)).toEqual([]);
  });
});

describe("staff adding a booking", () => {
  it("queues booking_confirmed, due now, when the guest opted in and gave a number", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db);

    expect((await addStaffBooking(actor(restaurantId), staffRequest(), now)).outcome).toBe("added");

    const [bookingId] = await bookingIdsOf(restaurantId);
    expect((await queuedFor(restaurantId)).filter(({ kind }) => kind === "booking_confirmed")).toMatchObject([
      { bookingId, kind: "booking_confirmed", status: "pending", scheduledFor: now },
    ]);
  });

  it("queues nothing without a number, opted in or not, or without the opt-in", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db, { tables: [{ capacity: 2 }, { capacity: 2 }] });

    expect((await addStaffBooking(actor(restaurantId), staffRequest({ phone: null }), now)).outcome).toBe("added");
    expect(
      (await addStaffBooking(actor(restaurantId), staffRequest({ whatsappOptIn: false }), now)).outcome,
    ).toBe("added");

    expect(await bookingIdsOf(restaurantId)).toHaveLength(2);
    expect(await queuedFor(restaurantId)).toEqual([]);
  });
});

describe("the outbox table", () => {
  it("holds one row per booking and kind: a second booking_confirmed for a booking is refused", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db);
    const [{ id: bookingId }] = await owner.db
      .insert(bookings)
      .values(aBooking(restaurantId, tableIds[0], "2026-11-06T17:00:00Z", "2026-11-06T19:00:00Z"))
      .returning({ id: bookings.id });
    const row = { restaurantId, bookingId, kind: "booking_confirmed" as const, scheduledFor: now };
    await owner.db.insert(notifications).values(row);

    await expect(owner.db.insert(notifications).values(row)).rejects.toMatchObject({
      cause: { code: "23505", constraint: "notifications_booking_id_kind_unique" },
    });
  });

  it("can't point a notification at another restaurant's booking", async () => {
    const mine = await bookableRestaurant(owner.db);
    const theirs = await bookableRestaurant(owner.db);
    const [{ id: bookingId }] = await owner.db
      .insert(bookings)
      .values(aBooking(theirs.restaurantId, theirs.tableIds[0], "2026-11-06T17:00:00Z", "2026-11-06T19:00:00Z"))
      .returning({ id: bookings.id });

    await expect(
      owner.db
        .insert(notifications)
        .values({ restaurantId: mine.restaurantId, bookingId, kind: "booking_confirmed", scheduledFor: now }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });
});
