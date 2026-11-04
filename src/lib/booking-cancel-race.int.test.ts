import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auditLog, bookings } from "@/db/schema";
import { aBooking, bookableRestaurant } from "../../test/integration/bookings";
import { openOwnerDatabase, testDatabaseSettings } from "../../test/integration/database";
import { type ActionOutcome, cancelBooking as staffCancel, seatBooking } from "./booking-day";
import { bookingActionResponse } from "./booking-day-responses";
import { cancelBooking as guestCancel, type CancelOutcome } from "./bookings";
import { bookingResponse } from "./manage-page";

/**
 * The day view's actions (#35) and the guest's manage page (#34) on one booking,
 * through the real functions: each is a status-guarded UPDATE, so whoever reaches
 * the row first wins and the other is told what it now is. A held row lock lines
 * them up, in the order each test starts them.
 */
const owner = openOwnerDatabase();

beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});
afterAll(async () => {
  await owner.pool.end();
  vi.unstubAllEnvs();
});

const MINUTE = 60_000;
const fromNow = (minutes: number) => new Date(Date.now() + minutes * MINUTE).toISOString();

async function aBookingToFightOver() {
  const { restaurantId, tableIds } = await bookableRestaurant(owner.db);
  const row = aBooking(restaurantId, tableIds[0], fromNow(300), fromNow(390));
  const [{ id }] = await owner.db.insert(bookings).values(row).returning({ id: bookings.id });
  return {
    id,
    token: row.manageToken,
    tenant: { restaurantId },
    actor: { restaurantId, staffId: crypto.randomUUID() },
  };
}

const rowOf = async (id: string) =>
  (await owner.db.select().from(bookings).where(eq(bookings.id, id)))[0];
const auditOf = (id: string) => owner.db.select().from(auditLog).where(eq(auditLog.entityId, id));

/** Backends queued behind this one, directly or behind each other on the row. */
const queuedBehind = (holder: number, length: number) =>
  vi.waitFor(
    async () => {
      const { rows } = await owner.db.execute<{ pid: number }>(sql`
        with recursive queue(pid) as (
          select pid from pg_stat_activity where ${holder} = any(pg_blocking_pids(pid))
          union
          select waiting.pid from pg_stat_activity waiting
          join queue on queue.pid = any(pg_blocking_pids(waiting.pid))
        )
        select pid from queue`);
      expect(rows).toHaveLength(length);
    },
    { timeout: 5_000, interval: 20 },
  );

/** Starts `first`, then `second`, both stopped on the booking's row, then lets them go. */
async function inOrder<A, B>(id: string, first: () => Promise<A>, second: () => Promise<B>) {
  const holder = await owner.pool.connect();
  try {
    await holder.query("begin");
    await holder.query("select 1 from bookings where id = $1 for update", [id]);
    const { rows } = await holder.query("select pg_backend_pid() as pid");
    const pid = rows[0].pid as number;

    const a = first();
    await queuedBehind(pid, 1);
    const b = second();
    await queuedBehind(pid, 2);
    await holder.query("commit");

    return [await a, await b] as const;
  } finally {
    holder.release(true);
  }
}

const staffAnswer = async (outcome: ActionOutcome, action: string) => {
  const response = bookingActionResponse(outcome, new Request("http://localhost/"), action);
  return { status: response.status, error: ((await response.json()) as { error: string }).error };
};

const guestAnswer = async (token: string, result: CancelOutcome) => {
  if (result.outcome === "not_found") throw new Error("the booking went missing");
  const response = bookingResponse(token, result.booking, result.outcome);
  return { status: response.status, page: await response.text() };
};

describe("staff and the guest cancelling one booking", () => {
  it("staff first: the guest is told it was already cancelled, and only staff's cancel stands", async () => {
    const { id, token, tenant, actor } = await aBookingToFightOver();

    const [staff, guest] = await inOrder(
      id,
      () => staffCancel(actor, id),
      () => guestCancel(tenant, token),
    );

    expect(staff).toEqual({ outcome: "done" });
    expect(guest.outcome).toBe("already_cancelled");
    const answer = await guestAnswer(token, guest);
    expect(answer.status).toBe(200);
    expect(answer.page).toContain("This booking was already cancelled.");
    expect(answer.page).not.toContain("Cancel booking");
    expect(await rowOf(id)).toMatchObject({ status: "cancelled", cancelledBy: "staff" });
    expect(await auditOf(id)).toHaveLength(1);
  });

  it("guest first: staff get a 409 saying so, the row stays the guest's, and nothing is audited", async () => {
    const { id, token, tenant, actor } = await aBookingToFightOver();

    const [guest, staff] = await inOrder(
      id,
      () => guestCancel(tenant, token),
      () => staffCancel(actor, id),
    );

    expect(guest.outcome).toBe("cancelled");
    expect((await guestAnswer(token, guest)).page).toContain("Your booking is cancelled.");
    expect(staff).toEqual({ outcome: "wrong_status", status: "cancelled" });
    expect(await staffAnswer(staff, "Cancel")).toEqual({
      status: 409,
      error: "Cancel didn't apply: this booking is already cancelled. Reload to see the latest.",
    });
    expect(await rowOf(id)).toMatchObject({ status: "cancelled", cancelledBy: "guest" });
    expect(await auditOf(id)).toEqual([]);
  });
});

describe("staff seating a booking the guest is cancelling", () => {
  it("seat first: the guest's cancel changes nothing, and the page says they're seated", async () => {
    const { id, token, tenant, actor } = await aBookingToFightOver();

    const [seat, guest] = await inOrder(
      id,
      () => seatBooking(actor, id),
      () => guestCancel(tenant, token),
    );

    expect(seat).toEqual({ outcome: "done" });
    expect(guest.outcome).toBe("not_cancellable");
    const answer = await guestAnswer(token, guest);
    expect(answer.status).toBe(409);
    expect(answer.page).toContain("This booking is under way: you&#39;re seated.");
    expect(await rowOf(id)).toMatchObject({ status: "seated", cancelledBy: null, cancelledAt: null });
  });

  it("guest first: Seat gets a 409 saying the booking is cancelled, and no one is seated", async () => {
    const { id, token, tenant, actor } = await aBookingToFightOver();

    const [guest, seat] = await inOrder(
      id,
      () => guestCancel(tenant, token),
      () => seatBooking(actor, id),
    );

    expect(guest.outcome).toBe("cancelled");
    expect(seat).toEqual({ outcome: "wrong_status", status: "cancelled" });
    expect(await staffAnswer(seat, "Seat")).toEqual({
      status: 409,
      error: "Seat didn't apply: this booking is already cancelled. Reload to see the latest.",
    });
    expect(await rowOf(id)).toMatchObject({ status: "cancelled", cancelledBy: "guest" });
  });
});
