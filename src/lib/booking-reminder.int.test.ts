import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bookings, notifications } from "@/db/schema";
import { bookableRestaurant } from "../../test/integration/bookings";
import { openOwnerDatabase, testDatabaseSettings } from "../../test/integration/database";
import { addDays, localToday } from "./booking-engine";
import { cancelBooking as staffCancel, finishBooking, markNoShow, seatBooking } from "./booking-day";
import { addStaffBooking, type StaffRequest } from "./booking-staff";
import { cancelBooking as guestCancel, confirmBooking, type GuestRequest } from "./bookings";

/**
 * The booking reminder (#45, spec 05, D-03): queued with the confirmation at
 * starts_at - 3h, skipped when that time has passed, and made `cancelled` on
 * every path that ends the booking early. As app_tenant, each test on a
 * restaurant of its own.
 */
const owner = openOwnerDatabase();
beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});
afterAll(async () => {
  await owner.pool.end();
  vi.unstubAllEnvs();
});

// 08:00 on Thursday 5 Nov in Harare; Friday's 19:00 dinner starts at 17:00Z.
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

const outboxOf = (restaurantId: string) =>
  owner.db
    .select({
      bookingId: notifications.bookingId,
      kind: notifications.kind,
      status: notifications.status,
      scheduledFor: notifications.scheduledFor,
    })
    .from(notifications)
    .where(eq(notifications.restaurantId, restaurantId));

const reminderOf = async (restaurantId: string) =>
  (await outboxOf(restaurantId)).find(({ kind }) => kind === "booking_reminder");

/** A restaurant with one confirmed booking made online, a reminder pending. */
async function confirmedOnline(at = now, request = guest(), rules = {}) {
  const { restaurantId } = await bookableRestaurant(owner.db, { rules });
  expect((await confirmBooking({ restaurantId }, request, at)).outcome).toBe("confirmed");
  const [booking] = await owner.db.select().from(bookings).where(eq(bookings.restaurantId, restaurantId));
  return { restaurantId, booking };
}

describe("queueing the reminder", () => {
  it("a guest's online booking queues booking_reminder at starts_at - 3h, beside the confirmation", async () => {
    const { restaurantId, booking } = await confirmedOnline();

    expect(booking.startsAt.toISOString()).toBe("2026-11-06T17:00:00.000Z");
    const outbox = await outboxOf(restaurantId);
    expect(outbox.map(({ kind }) => kind).sort()).toEqual(["booking_confirmed", "booking_reminder"]);
    expect(await reminderOf(restaurantId)).toEqual({
      bookingId: booking.id,
      kind: "booking_reminder",
      status: "pending",
      scheduledFor: new Date("2026-11-06T14:00:00Z"),
    });
  });

  it("staff adding a booking queues it the same way", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db);

    expect((await addStaffBooking(actor(restaurantId), staffRequest(), now)).outcome).toBe("added");

    expect(await reminderOf(restaurantId)).toMatchObject({
      status: "pending",
      scheduledFor: new Date("2026-11-06T14:00:00Z"),
    });
  });

  it("skips it when starts_at - 3h has already passed, and still queues the confirmation", async () => {
    // 15:30 Thursday->Friday: it is 16:30 on Friday in Harare, so 19:00 is 2.5 hours away.
    const late = new Date("2026-11-06T14:30:00Z");
    const { restaurantId } = await confirmedOnline(late, guest(), { minLeadMinutes: 0 });

    expect((await outboxOf(restaurantId)).map(({ kind }) => kind)).toEqual(["booking_confirmed"]);
  });

  it("queues it when starts_at - 3h is exactly now", async () => {
    const exactly = new Date("2026-11-06T14:00:00Z");
    const { restaurantId } = await confirmedOnline(exactly, guest(), { minLeadMinutes: 0 });

    expect(await reminderOf(restaurantId)).toMatchObject({ status: "pending", scheduledFor: exactly });
  });

  it("queues nothing for a guest without opt-in or without a number", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db, { tables: [{ capacity: 2 }, { capacity: 2 }] });
    await addStaffBooking(actor(restaurantId), staffRequest({ whatsappOptIn: false }), now);
    await addStaffBooking(actor(restaurantId), staffRequest({ phone: null }), now);

    expect(await outboxOf(restaurantId)).toEqual([]);
  });
});

describe("the reminder ends with the booking", () => {
  it("a guest's cancel makes the pending reminder cancelled", async () => {
    // Real clock: the guest's cutoff is judged by Postgres's now(), so the booking is days away.
    const real = new Date();
    const day = addDays(localToday(real, "Africa/Harare"), 3);
    const { restaurantId, booking } = await confirmedOnline(real, guest({ date: day }));
    expect(await reminderOf(restaurantId)).toMatchObject({ status: "pending" });

    expect((await guestCancel({ restaurantId }, booking.manageToken)).outcome).toBe("cancelled");

    expect(await reminderOf(restaurantId)).toMatchObject({ status: "cancelled" });
  });

  it("staff's Cancel makes it cancelled", async () => {
    const { restaurantId, booking } = await confirmedOnline();

    expect((await staffCancel(actor(restaurantId), booking.id)).outcome).toBe("done");

    expect(await reminderOf(restaurantId)).toMatchObject({ status: "cancelled" });
  });

  it("staff's No-show makes it cancelled", async () => {
    const { restaurantId, booking } = await confirmedOnline();

    expect((await markNoShow(actor(restaurantId), booking.id)).outcome).toBe("done");

    expect(await reminderOf(restaurantId)).toMatchObject({ status: "cancelled" });
  });

  it("Seat then Finish makes it cancelled by the end at the latest", async () => {
    const { restaurantId, booking } = await confirmedOnline();
    await seatBooking(actor(restaurantId), booking.id);
    expect((await finishBooking(actor(restaurantId), booking.id)).outcome).toBe("done");

    expect(await reminderOf(restaurantId)).toMatchObject({ status: "cancelled" });
  });

  it("leaves the confirmation as it was, and another booking's reminder alone", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db, { tables: [{ capacity: 2 }, { capacity: 2 }] });
    await confirmBooking({ restaurantId }, guest({ phone: "+263771111111" }), now);
    await confirmBooking({ restaurantId }, guest({ phone: "+263772222222" }), now);
    const [first] = await owner.db.select().from(bookings).where(eq(bookings.restaurantId, restaurantId));

    await staffCancel(actor(restaurantId), first.id);

    const rows = await owner.db
      .select({ bookingId: notifications.bookingId, kind: notifications.kind, status: notifications.status })
      .from(notifications)
      .where(eq(notifications.restaurantId, restaurantId));
    const of = (bookingId: string, kind: string) => rows.find((r) => r.bookingId === bookingId && r.kind === kind)?.status;
    expect(of(first.id, "booking_reminder")).toBe("cancelled");
    expect(of(first.id, "booking_confirmed")).toBe("pending");
    const other = rows.find((r) => r.bookingId !== first.id)!.bookingId;
    expect(of(other, "booking_reminder")).toBe("pending");
  });

  it("does not touch a reminder that is already sent", async () => {
    const { restaurantId, booking } = await confirmedOnline();
    await owner.db
      .update(notifications)
      .set({ status: "sent" })
      .where(and(eq(notifications.bookingId, booking.id), eq(notifications.kind, "booking_reminder")));

    await staffCancel(actor(restaurantId), booking.id);

    expect(await reminderOf(restaurantId)).toMatchObject({ status: "sent" });
  });
});
