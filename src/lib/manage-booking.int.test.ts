import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bookings, bookingSettings } from "@/db/schema";
import { aBooking, bookableRestaurant } from "../../test/integration/bookings";
import { openOwnerDatabase, testDatabaseSettings } from "../../test/integration/database";
import { cancelBooking, getBookingPage, getManagedBooking } from "./bookings";
import { resolvePublicToken } from "./tenant/public";

/**
 * A guest's manage link (spec 04): the token is the only tenant input, and the
 * cancel is decided by Postgres, at its own now(), in one guarded statement.
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
const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * MINUTE);

/** A confirmed booking `minutes` from now, on a restaurant of its own (cutoff 120). */
async function bookedIn(
  minutes: number,
  extra: Partial<typeof bookings.$inferInsert> = {},
  restaurant?: Awaited<ReturnType<typeof bookableRestaurant>>,
) {
  const { restaurantId, tableIds, slug } = restaurant ?? (await bookableRestaurant(owner.db));
  const start = minutesFromNow(minutes);
  const row = {
    ...aBooking(restaurantId, tableIds[0], start.toISOString(), minutesFromNow(minutes + 90).toISOString()),
    ...extra,
  };
  await owner.db.insert(bookings).values(row);
  return { restaurantId, tableIds, slug, token: row.manageToken, tenant: { restaurantId } };
}

const rowOf = async (token: string) =>
  (await owner.db.select().from(bookings).where(eq(bookings.manageToken, token)))[0];

describe("the manage token as the only tenant input", () => {
  it("resolves to the booking's restaurant, and an unknown token or a NUL to nothing", async () => {
    const { restaurantId, token } = await bookedIn(300);

    expect(await resolvePublicToken("manage", token)).toEqual({ restaurantId });
    expect(await resolvePublicToken("manage", "no-such-token")).toBeUndefined();
    expect(await resolvePublicToken("manage", "a\0b")).toBeUndefined();
  });

  it("finds a booking only inside its own restaurant", async () => {
    const mine = await bookedIn(300);
    const theirs = await bookedIn(300);

    expect(await getManagedBooking(mine.tenant, mine.token)).toMatchObject({ status: "confirmed" });
    expect(await getManagedBooking(mine.tenant, theirs.token)).toBeUndefined();
    expect(await getManagedBooking(theirs.tenant, mine.token)).toBeUndefined();
  });
});

describe("what the guest sees", () => {
  it("shows the booking in the restaurant's time zone, and nothing of the table or another guest", async () => {
    const restaurant = await bookableRestaurant(owner.db, { timezone: "Pacific/Auckland" });
    const { token, tenant } = await bookedIn(
      300,
      {
        startsAt: new Date("2026-11-06T17:00:00Z"),
        endsAt: new Date("2026-11-06T18:30:00Z"),
        holdEndsAt: new Date("2026-11-06T18:45:00Z"),
        guestPhone: "+263712000999",
        guestNote: "window",
      },
      restaurant,
    );
    await owner.db
      .insert(bookings)
      .values({
        ...aBooking(
          restaurant.restaurantId,
          restaurant.tableIds[0],
          "2030-01-01T10:00:00Z",
          "2030-01-01T11:00:00Z",
        ),
        guestName: "Somebody else",
      });

    const seen = await getManagedBooking(tenant, token);

    // 17:00Z on 6 Nov is 06:00 on the 7th in Auckland (NZDT, +13).
    expect(seen).toMatchObject({ time: "06:00", dateLabel: "Sat 7 Nov", party: 2 });
    expect(Object.keys(seen!).sort()).toEqual([
      "cancellable",
      "cancelledBy",
      "contactPhone",
      "dateLabel",
      "guestName",
      "note",
      "party",
      "restaurantName",
      "status",
      "time",
    ]);
    expect(JSON.stringify(seen)).not.toContain("Somebody else");
    expect(JSON.stringify(seen)).not.toContain(restaurant.tableIds[0]);
    expect(JSON.stringify(seen)).not.toContain("712000999");
  });

  it("offers the cancel only while it's before the cutoff", async () => {
    const early = await bookedIn(130);
    const late = await bookedIn(110);
    const started = await bookedIn(-10);

    expect((await getManagedBooking(early.tenant, early.token))?.cancellable).toBe(true);
    expect((await getManagedBooking(late.tenant, late.token))?.cancellable).toBe(false);
    expect((await getManagedBooking(started.tenant, started.token))?.cancellable).toBe(false);
  });
});

describe("cancelBooking", () => {
  it("before the cutoff: cancelled by the guest, with the time", async () => {
    const { token, tenant } = await bookedIn(130);
    const before = Date.now();

    const result = await cancelBooking(tenant, token);

    expect(result.outcome).toBe("cancelled");
    const row = await rowOf(token);
    expect(row).toMatchObject({ status: "cancelled", cancelledBy: "guest" });
    expect(row.cancelledAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row.cancelledAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("after the cutoff: refused, and the booking is untouched", async () => {
    const { token, tenant } = await bookedIn(110);

    const result = await cancelBooking(tenant, token);

    expect(result.outcome).toBe("too_late");
    expect(await rowOf(token)).toMatchObject({ status: "confirmed", cancelledBy: null, cancelledAt: null });
  });

  it("the cutoff is the restaurant's own setting, read at the moment of the cancel", async () => {
    const { token, tenant, restaurantId } = await bookedIn(130);
    await owner.db
      .update(bookingSettings)
      .set({ guestCancelCutoffMinutes: 240 })
      .where(eq(bookingSettings.restaurantId, restaurantId));

    expect((await cancelBooking(tenant, token)).outcome).toBe("too_late");

    await owner.db
      .update(bookingSettings)
      .set({ guestCancelCutoffMinutes: 60 })
      .where(eq(bookingSettings.restaurantId, restaurantId));
    expect((await cancelBooking(tenant, token)).outcome).toBe("cancelled");
  });

  it("twice is safe, says it was already cancelled, and keeps the first time", async () => {
    const { token, tenant } = await bookedIn(300);
    await cancelBooking(tenant, token);
    const first = await rowOf(token);

    const again = await cancelBooking(tenant, token);

    expect(again.outcome).toBe("already_cancelled");
    expect(await rowOf(token)).toEqual(first);
  });

  it.each(["seated", "completed", "no_show"] as const)(
    "a %s booking shows its state and can't be cancelled",
    async (status) => {
      const { token, tenant } = await bookedIn(300, { status });

      const result = await cancelBooking(tenant, token);

      expect(result).toMatchObject({ outcome: "not_cancellable", booking: { status } });
      expect(await rowOf(token)).toMatchObject({ status, cancelledBy: null });
    },
  );

  it("a booking the restaurant cancelled says so, and the guest can't cancel it again", async () => {
    const { token, tenant } = await bookedIn(300, {
      status: "cancelled",
      cancelledBy: "staff",
      cancelledAt: new Date(),
    });

    const result = await cancelBooking(tenant, token);

    expect(result).toMatchObject({
      outcome: "already_cancelled",
      booking: { status: "cancelled", cancelledBy: "staff" },
    });
    expect(await rowOf(token)).toMatchObject({ cancelledBy: "staff" });
  });

  it("is nothing for another restaurant's token or an unknown one", async () => {
    const mine = await bookedIn(300);
    const theirs = await bookedIn(300);

    expect((await cancelBooking(mine.tenant, theirs.token)).outcome).toBe("not_found");
    expect((await cancelBooking(mine.tenant, "no-such-token")).outcome).toBe("not_found");
    expect(await rowOf(theirs.token)).toMatchObject({ status: "confirmed" });
  });

  it("frees the table: the availability list offers the time again", async () => {
    const restaurant = await bookableRestaurant(owner.db);
    const start = new Date(Date.now() + 3 * 24 * 60 * MINUTE);
    // 19:00 in Harare on a day three days out.
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Harare" }).format(start);
    const seven = new Date(`${day}T17:00:00Z`);
    const { token, tenant } = await bookedIn(
      0,
      { startsAt: seven, endsAt: new Date(seven.getTime() + 90 * MINUTE), holdEndsAt: new Date(seven.getTime() + 105 * MINUTE) },
      restaurant,
    );
    const offered = async () =>
      (await getBookingPage(tenant, { party: "2", date: day })).times?.map((slot) => slot.time);
    expect(await offered()).not.toContain("19:00");

    await cancelBooking(tenant, token);

    expect(await offered()).toContain("19:00");
  });

  it("does not touch the audit log: a guest's cancel isn't on spec 01's list", async () => {
    const { token, tenant, restaurantId } = await bookedIn(300);
    const count = async () =>
      (
        await owner.db.execute<{ n: number }>(
          sql`select count(*)::int as n from audit_log where restaurant_id = ${restaurantId}`,
        )
      ).rows[0].n;
    const before = await count();

    await cancelBooking(tenant, token);

    expect(await count()).toBe(before);
  });
});

describe("a cancel racing a staff action", () => {
  const pidOf = async (client: { query: (text: string) => Promise<{ rows: { pid: number }[] }> }) =>
    (await client.query("select pg_backend_pid() as pid")).rows[0].pid;

  const blockedBehind = (holder: number) =>
    vi.waitFor(
      async () => {
        const { rows } = await owner.db.execute<{ pid: number }>(sql`
          select pid from pg_stat_activity where ${holder} = any(pg_blocking_pids(pid))
        `);
        expect(rows).toHaveLength(1);
        return rows[0].pid;
      },
      { timeout: 5_000, interval: 20 },
    );

  it.each([
    ["seated", "update bookings set status = 'seated' where manage_token = $1"],
    ["no_show", "update bookings set status = 'no_show' where manage_token = $1"],
  ])("a guest cancel of a booking just made %s does not win", async (status, statement) => {
    const { token, tenant } = await bookedIn(130);
    const staff = await owner.pool.connect();
    try {
      await staff.query("begin");
      await staff.query(statement, [token]);
      const pid = await pidOf(staff);

      const cancelling = cancelBooking(tenant, token);
      await blockedBehind(pid);
      await staff.query("commit");

      expect(await cancelling).toMatchObject({ outcome: "not_cancellable", booking: { status } });
      expect(await rowOf(token)).toMatchObject({ status, cancelledBy: null, cancelledAt: null });
    } finally {
      staff.release(true);
    }
  });

  it("two cancels at once: one cancels, the other is told it already was", async () => {
    const { token, tenant } = await bookedIn(300);

    const outcomes = (
      await Promise.all([cancelBooking(tenant, token), cancelBooking(tenant, token)])
    )
      .map((result) => result.outcome)
      .sort();

    expect(outcomes).toEqual(["already_cancelled", "cancelled"]);
  });
});
