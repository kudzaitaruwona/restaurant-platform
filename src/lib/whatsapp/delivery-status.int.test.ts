import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { bookings, notifications } from "@/db/schema";
import { aBooking, bookableRestaurant } from "../../../test/integration/bookings";
import { openOwnerDatabase, openSystemDatabase } from "../../../test/integration/database";
import { applyDeliveryStatuses } from "./delivery-status";

/**
 * Meta's delivery statuses written to the outbox (spec 05, Delivery status), as
 * the webhook writes them: as app_system, against real rows, matched by the
 * message id the send got back. Each test's message ids are its own, so rows
 * other files leave behind are never touched.
 */
const owner = openOwnerDatabase();
const system = openSystemDatabase();
afterAll(() => Promise.all([owner.pool.end(), system.pool.end()]));

type Status = (typeof notifications.$inferSelect)["status"];

/** A booking and its booking_confirmed row, already sent with a message id of its own. */
async function aSentConfirmation(status: Status = "sent", restaurant?: { restaurantId: string; tableIds: string[] }) {
  const { restaurantId, tableIds } = restaurant ?? (await bookableRestaurant(owner.db));
  const [booking] = await owner.db
    .insert(bookings)
    .values({ ...aBooking(restaurantId, tableIds[0], "2031-02-01T17:00:00Z", "2031-02-01T19:00:00Z"), guestPhone: "+263771234567" })
    .returning({ id: bookings.id, status: bookings.status });
  const providerMessageId = `wamid.${crypto.randomUUID()}`;
  const [{ id }] = await owner.db
    .insert(notifications)
    .values({
      restaurantId,
      bookingId: booking.id,
      kind: "booking_confirmed",
      scheduledFor: new Date("2031-01-01T00:00:00Z"),
      status,
      attempts: 1,
      providerMessageId: status === "pending" ? null : providerMessageId,
      claimedAt: new Date(),
    })
    .returning({ id: notifications.id });
  return { restaurantId, bookingId: booking.id, id, providerMessageId };
}

const notification = async (id: string) =>
  (await owner.db.select().from(notifications).where(eq(notifications.id, id)))[0];

describe("applyDeliveryStatuses", () => {
  it.each(["delivered", "read", "failed"] as const)("moves a sent message to %s, matched by Meta's id", async (status) => {
    const { id, providerMessageId } = await aSentConfirmation();

    expect(await applyDeliveryStatuses(system.db, [{ providerMessageId, status }])).toBe(1);

    expect((await notification(id)).status).toBe(status);
  });

  it("keeps Meta's reason for a failure in last_error, and leaves the booking as it was", async () => {
    const { id, bookingId, providerMessageId } = await aSentConfirmation();

    await applyDeliveryStatuses(system.db, [
      { providerMessageId, status: "failed", error: "Meta 131026: Message undeliverable" },
    ]);

    expect(await notification(id)).toMatchObject({ status: "failed", lastError: "Meta 131026: Message undeliverable" });
    const [booking] = await owner.db.select({ status: bookings.status }).from(bookings).where(eq(bookings.id, bookingId));
    expect(booking.status).toBe("confirmed");
  });

  it("takes several statuses in one callback, each for its own message", async () => {
    const restaurant = await bookableRestaurant(owner.db, { tables: [{ capacity: 2 }, { capacity: 2 }] });
    const first = await aSentConfirmation("sent", restaurant);
    const other = await bookableRestaurant(owner.db);
    const second = await aSentConfirmation("sent", other);

    expect(
      await applyDeliveryStatuses(system.db, [
        { providerMessageId: first.providerMessageId, status: "delivered" },
        { providerMessageId: second.providerMessageId, status: "read" },
      ]),
    ).toBe(2);

    expect((await notification(first.id)).status).toBe("delivered");
    expect((await notification(second.id)).status).toBe("read");
  });

  it("applies statuses in the order Meta listed them", async () => {
    const { id, providerMessageId } = await aSentConfirmation();

    await applyDeliveryStatuses(system.db, [
      { providerMessageId, status: "delivered" },
      { providerMessageId, status: "read" },
    ]);

    expect((await notification(id)).status).toBe("read");
  });

  it("ignores a message id it never sent", async () => {
    expect(
      await applyDeliveryStatuses(system.db, [{ providerMessageId: `wamid.${crypto.randomUUID()}`, status: "read" }]),
    ).toBe(0);
  });

  describe("out of order: a status only ever moves forward (sent, delivered, read)", () => {
    it.each([
      ["read", "sent"],
      ["read", "delivered"],
      ["read", "failed"],
      ["delivered", "sent"],
      ["delivered", "failed"],
    ] as const)("a late %s isn't overwritten by %s", async (current, late) => {
      const { id, providerMessageId } = await aSentConfirmation(current);

      expect(await applyDeliveryStatuses(system.db, [{ providerMessageId, status: late, error: "Meta 1: late" }])).toBe(0);

      expect(await notification(id)).toMatchObject({ status: current, lastError: null });
    });

    it.each(["delivered", "read"] as const)(
      "a failure is overruled by %s, which proves the guest got it",
      async (status) => {
        const { id, providerMessageId } = await aSentConfirmation("failed");

        expect(await applyDeliveryStatuses(system.db, [{ providerMessageId, status }])).toBe(1);

        expect((await notification(id)).status).toBe(status);
      },
    );

    it("a late sent changes nothing", async () => {
      const { id, providerMessageId } = await aSentConfirmation("failed");
      expect(await applyDeliveryStatuses(system.db, [{ providerMessageId, status: "sent" }])).toBe(0);
      expect((await notification(id)).status).toBe("failed");
    });

    it("the same status twice changes nothing the second time", async () => {
      const { providerMessageId } = await aSentConfirmation();
      expect(await applyDeliveryStatuses(system.db, [{ providerMessageId, status: "delivered" }])).toBe(1);
      expect(await applyDeliveryStatuses(system.db, [{ providerMessageId, status: "delivered" }])).toBe(0);
    });

    it.each(["cancelled", "sending"] as const)("never touches a row in %s", async (current) => {
      const { id, providerMessageId } = await aSentConfirmation(current);
      for (const status of ["sent", "delivered", "read", "failed"] as const) {
        await applyDeliveryStatuses(system.db, [{ providerMessageId, status }]);
      }
      expect((await notification(id)).status).toBe(current);
    });
  });
});
