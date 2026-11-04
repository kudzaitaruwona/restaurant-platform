import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bookings, bookingSettings, diningTables, servicePeriods } from "@/db/schema";
import { addDays, localToday } from "@/lib/booking-engine";
import { settingFields } from "@/lib/booking-settings";
import {
  aBooking,
  asTenant,
  bookableRestaurant,
  bookingsOf,
} from "../../test/integration/bookings";
import {
  openOwnerDatabase,
  openTestDatabase,
  testDatabaseSettings,
} from "../../test/integration/database";
import {
  confirmBooking,
  firstTableToTake,
  getBookingPage,
  type GuestRequest,
  listTodaysBookings,
  MAX_HOLD_MS,
  parseGuestRequest,
} from "./bookings";

/** The engine against real rows, as app_tenant, on restaurants of their own. */
const app = openTestDatabase();
const owner = openOwnerDatabase();

beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});
afterAll(async () => {
  await Promise.all([app.pool.end(), owner.pool.end()]);
  vi.unstubAllEnvs();
});

// A Thursday, 08:00 in Harare. Friday's dinner is well clear of the lead time.
const now = new Date("2026-11-05T06:00:00Z");
const date = "2026-11-06";
/** 19:00 in Harare. */
const SEVEN = "2026-11-06T17:00:00Z";

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

const form = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return body;
};

const filled = {
  party: "2",
  date,
  time: "19:00",
  name: "Tariro",
  countryCode: "+263",
  phone: "0771 234 567",
  consent: "on",
};

describe("a guest's request", () => {
  it("normalises the number to E.164 and records the consent", () => {
    expect(parseGuestRequest(form(filled))).toEqual({
      success: true,
      data: guest(),
    });
  });

  it("defaults the country code to +263", () => {
    const body = form(filled);
    body.delete("countryCode");
    const parsed = parseGuestRequest(body);
    expect(parsed.success && parsed.data.phone).toBe("+263771234567");
  });

  it("keeps a number typed with its own country code", () => {
    const parsed = parseGuestRequest(form({ ...filled, phone: "+27 82 123 4567" }));
    expect(parsed.success && parsed.data.phone).toBe("+27821234567");
  });

  it("stores a blank note as no note, and a real one trimmed", () => {
    const blank = parseGuestRequest(form({ ...filled, note: "   " }));
    expect(blank.success && blank.data.note).toBeNull();
    const birthday = parseGuestRequest(form({ ...filled, note: " birthday " }));
    expect(birthday.success && birthday.data.note).toBe("birthday");
  });

  it.each([
    ["no name", { name: "   " }],
    ["a name over 100 characters", { name: "x".repeat(101) }],
    ["a NUL in the name", { name: "a\0b" }],
    ["a note over 200 characters", { note: "x".repeat(201) }],
    ["a NUL in the note", { note: "a\0b" }],
    ["no phone", { phone: "" }],
    ["letters for a phone", { phone: "call me" }],
    ["a NUL in the phone", { phone: "077\x00123" }],
    ["a date that doesn't exist", { date: "2026-02-31" }],
    ["a time that isn't one", { time: "25:00" }],
    ["a party of none", { party: "0" }],
    ["a party that isn't a number", { party: "two" }],
  ])("refuses %s", (_what, change) => {
    expect(parseGuestRequest(form({ ...filled, ...change })).success).toBe(false);
  });

  it("refuses a booking with no consent", () => {
    const body = form(filled);
    body.delete("consent");
    expect(parseGuestRequest(body)).toEqual({
      success: false,
      message: expect.stringContaining("Tick the box"),
    });
  });

  it("doesn't echo a refused value back", () => {
    const parsed = parseGuestRequest(form({ ...filled, phone: "secret-value" }));
    expect(JSON.stringify(parsed)).not.toContain("secret-value");
  });
});

describe("firstTableToTake, on a real transaction", () => {
  const seat = (restaurantId: string, tableId: string, attempted: string[]) =>
    async (attempt: Parameters<Parameters<typeof firstTableToTake>[2]>[0], id: string) => {
      attempted.push(id);
      await attempt
        .insert(bookings)
        .values(aBooking(restaurantId, id, SEVEN, "2026-11-06T19:00:00Z"));
      return id === tableId;
    };

  async function twoTablesFirstTaken() {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 2 }, { capacity: 2 }, { capacity: 2 }],
    });
    await owner.db
      .insert(bookings)
      .values(aBooking(restaurantId, tableIds[0], SEVEN, "2026-11-06T19:00:00Z"));
    return { restaurantId, tableIds };
  }

  it("moves on to the next candidate after a violation, in the same transaction", async () => {
    const { restaurantId, tableIds } = await twoTablesFirstTaken();
    const attempted: string[] = [];

    const result = await asTenant(app.db, restaurantId, async (tx) => {
      const { rows: [{ xid: before }] } = await tx.execute(sql`select pg_current_xact_id()::text as xid`);
      const seated = await firstTableToTake(tx, tableIds, seat(restaurantId, tableIds[1], attempted));
      const { rows: [{ xid: after }] } = await tx.execute(sql`select pg_current_xact_id()::text as xid`);
      return { seated, sameTransaction: before === after };
    });

    expect(result).toEqual({ seated: true, sameTransaction: true });
    expect(attempted).toEqual(tableIds.slice(0, 2));
    const rows = await bookingsOf(owner.db, restaurantId);
    expect(rows.map((row) => row.tableId).sort()).toEqual(tableIds.slice(0, 2).sort());
  });

  it("leaves the transaction usable, and the tenant set, when every candidate fails", async () => {
    const { restaurantId, tableIds } = await twoTablesFirstTaken();

    const after = await asTenant(app.db, restaurantId, async (tx) => {
      const seated = await firstTableToTake(tx, [tableIds[0]], seat(restaurantId, "", []));
      const visible = await tx.select({ id: bookings.id }).from(bookings);
      return { seated, visible: visible.length };
    });

    expect(after).toEqual({ seated: undefined, visible: 1 });
  });

  it("treats losing a deadlock like losing the table, and goes on", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 2 }, { capacity: 2 }],
    });

    const seated = await asTenant(app.db, restaurantId, (tx) =>
      firstTableToTake(tx, tableIds, async (attempt, id) => {
        if (id === tableIds[0]) {
          await attempt.execute(
            sql`do $$ begin raise exception 'deadlock' using errcode = '40P01'; end $$`,
          );
        }
        return id;
      }),
    );

    expect(seated).toBe(tableIds[1]);
  });

  it("rolls the failed candidate back: nothing it wrote survives", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 2 }, { capacity: 2 }],
    });
    const taken = { cause: { code: "23P01", constraint: "bookings_no_overlap" } };

    await asTenant(app.db, restaurantId, (tx) =>
      firstTableToTake(tx, tableIds, async (attempt, id) => {
        await attempt
          .insert(bookings)
          .values(aBooking(restaurantId, id, SEVEN, "2026-11-06T19:00:00Z"));
        if (id === tableIds[0]) throw Object.assign(new Error("taken"), taken);
      }),
    );

    const rows = await bookingsOf(owner.db, restaurantId);
    expect(rows.map((row) => row.tableId)).toEqual([tableIds[1]]);
  });

  it("doesn't swallow any other failure", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db);

    await expect(
      asTenant(app.db, restaurantId, (tx) =>
        firstTableToTake(tx, tableIds, (attempt) =>
          attempt.insert(bookings).values({
            ...aBooking(restaurantId, tableIds[0], SEVEN, "2026-11-06T19:00:00Z"),
            guestName: " ",
          }),
        ),
      ),
    ).rejects.toMatchObject({ cause: { constraint: "bookings_guest_name" } });
  });

  it("doesn't take another exclusion constraint for a lost table", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db);
    const elsewhere = { cause: { code: "23P01", constraint: "service_periods_no_overlap" } };

    await expect(
      asTenant(app.db, restaurantId, (tx) =>
        firstTableToTake(tx, tableIds, async () => {
          throw Object.assign(new Error("other"), elsewhere);
        }),
      ),
    ).rejects.toMatchObject(elsewhere);
  });
});

describe("confirming", () => {
  it("books the best-fit table, with the sitting and buffer from the rules", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, {
      tables: [
        { capacity: 8 },
        { capacity: 4, sortOrder: 2 },
        { capacity: 4, sortOrder: 1 },
        { capacity: 2 },
      ],
    });

    const result = await confirmBooking({ restaurantId }, guest({ party: 3 }), now);

    expect(result.outcome).toBe("confirmed");
    const [booked] = await bookingsOf(owner.db, restaurantId);
    expect(booked).toMatchObject({
      tableId: tableIds[2],
      guestName: "Tariro",
      guestPhone: "+263771234567",
      whatsappOptIn: true,
      partySize: 3,
      status: "confirmed",
      source: "online",
      startsAt: new Date(SEVEN),
      endsAt: new Date("2026-11-06T18:30:00Z"),
      holdEndsAt: new Date("2026-11-06T18:45:00Z"),
    });
  });

  it("falls through to the next table when the list's first choice has gone", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 2 }, { capacity: 4 }],
    });
    await owner.db
      .insert(bookings)
      .values(aBooking(restaurantId, tableIds[0], SEVEN, "2026-11-06T19:00:00Z"));

    const result = await confirmBooking({ restaurantId }, guest(), now);

    expect(result.outcome).toBe("confirmed");
    const rows = await bookingsOf(owner.db, restaurantId);
    expect(rows.filter((row) => row.guestName === "Tariro").map((row) => row.tableId)).toEqual([
      tableIds[1],
    ]);
  });

  it("tells the guest what was booked and never the table", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 2, label: "Secret corner" }],
    });

    const result = await confirmBooking({ restaurantId }, guest(), now);

    expect(result).toMatchObject({
      outcome: "confirmed",
      confirmation: {
        restaurantName: `Restaurant ${restaurantId}`,
        dateLabel: "Fri 6 Nov",
        time: "19:00",
        party: 2,
        contactPhone: "+263771234567",
      },
    });
    const told = JSON.stringify(result);
    expect(told).not.toContain(tableIds[0]);
    expect(told).not.toContain("Secret corner");
  });

  it("gives each booking a manage token of its own, 22 characters of base62", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db);

    const first = await confirmBooking({ restaurantId }, guest({ time: "18:00" }), now);
    const second = await confirmBooking({ restaurantId }, guest({ time: "20:00" }), now);

    const tokens = [first, second].map((result) =>
      result.outcome === "confirmed" ? result.confirmation.manageToken : "",
    );
    for (const token of tokens) expect(token).toMatch(/^[0-9A-Za-z]{22}$/);
    expect(tokens[0]).not.toBe(tokens[1]);
    const rows = await bookingsOf(owner.db, restaurantId);
    expect(rows.map((row) => row.manageToken).sort()).toEqual(tokens.sort());
  });

  it("stores the consent the guest gave", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db);

    await confirmBooking({ restaurantId }, guest({ whatsappOptIn: false }), now);

    const [booked] = await bookingsOf(owner.db, restaurantId);
    expect(booked.whatsappOptIn).toBe(false);
  });

  it("refuses on the server while booking is off, not just on the page", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db, { rules: { enabled: false } });

    expect(await confirmBooking({ restaurantId }, guest(), now)).toEqual({ outcome: "closed" });
    expect(await bookingsOf(owner.db, restaurantId)).toEqual([]);
  });

  it("doesn't seat a party at a walk-ins-only table, or an archived one", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 2 }, { capacity: 2, bookable: false }, { capacity: 2 }],
    });
    await owner.db
      .update(diningTables)
      .set({ archivedAt: now })
      .where(eq(diningTables.id, tableIds[2]));
    await owner.db
      .insert(bookings)
      .values(aBooking(restaurantId, tableIds[0], SEVEN, "2026-11-06T19:00:00Z"));

    const result = await confirmBooking({ restaurantId }, guest(), now);

    expect(result.outcome).toBe("race_lost");
    expect(await bookingsOf(owner.db, restaurantId)).toHaveLength(1);
  });

  it("refuses a party above max_online_party_size, whatever the table could take", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 10 }],
      rules: { maxOnlinePartySize: 6 },
    });

    expect(await confirmBooking({ restaurantId }, guest({ party: 7 }), now)).toEqual({
      outcome: "party_too_large",
      threshold: 7,
      contactPhone: "+263771234567",
      whatsappLink: "https://wa.me/263771234567",
    });
    expect((await confirmBooking({ restaurantId }, guest({ party: 6 }), now)).outcome).toBe(
      "confirmed",
    );
  });

  it("offers the nearest times the party can still have when every table has gone", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db);
    await owner.db
      .insert(bookings)
      .values(aBooking(restaurantId, tableIds[0], SEVEN, "2026-11-06T19:00:00Z"));

    expect(await confirmBooking({ restaurantId }, guest(), now)).toEqual({
      outcome: "race_lost",
      times: [{ period: "Dinner", time: "21:00" }],
    });
  });

  it("holds no guest details in the error when the insert fails for another reason", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db);

    const failure = await confirmBooking(
      { restaurantId },
      guest({ note: "x".repeat(201), phone: "+263770000001" }),
      now,
    ).catch((error: Error) => error);

    expect(failure).toBeInstanceOf(Error);
    const logged = JSON.stringify([
      (failure as Error).message,
      (failure as Error).stack,
      (failure as Error).cause,
    ]);
    expect(logged).toContain("23514");
    expect(logged).not.toContain("+263770000001");
    expect(logged).not.toContain("Tariro");
    expect(await bookingsOf(owner.db, restaurantId)).toEqual([]);
  });
});

describe("two guests at once", () => {
  const pidOf = async (client: { query: (text: string) => Promise<{ rows: { pid: number }[] }> }) =>
    (await client.query("select pg_backend_pid() as pid")).rows[0].pid;

  /**
   * The backend waiting on this particular holder. Integration files share one
   * database, so "anything waiting on a lock" could be somebody else's test.
   */
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

  const holdLastTable = (restaurantId: string, tableId: string, token: string) => `
    insert into bookings (restaurant_id, table_id, guest_name, whatsapp_opt_in, party_size,
      starts_at, ends_at, hold_ends_at, status, source, manage_token)
    values ('${restaurantId}', '${tableId}', 'First guest', true, 2,
      '${SEVEN}', '2026-11-06T18:30:00Z', '2026-11-06T18:45:00Z', 'confirmed', 'online', '${token}')
  `;

  /**
   * The first guest's insert is in, not committed, so the second can't see it: its
   * list still shows the table. The second must wait for the outcome.
   */
  async function raceAgainstHolder(finish: "commit" | "rollback") {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db);
    const holder = await owner.pool.connect();
    try {
      await holder.query("begin");
      await holder.query(holdLastTable(restaurantId, tableIds[0], crypto.randomUUID().replaceAll("-", "")));
      const pid = await pidOf(holder);

      const second = confirmBooking({ restaurantId }, guest({ name: "Second guest" }), now);
      await blockedBehind(pid);
      await holder.query(finish);

      return { restaurantId, result: await second };
    } finally {
      // Destroyed rather than returned: a failed test can leave it mid-transaction.
      holder.release(true);
    }
  }

  it("the one who waited gets the race-lost answer when the other commits", async () => {
    const { restaurantId, result } = await raceAgainstHolder("commit");

    expect(result).toEqual({
      outcome: "race_lost",
      times: [{ period: "Dinner", time: "21:00" }],
    });
    const rows = await bookingsOf(owner.db, restaurantId);
    expect(rows.map((row) => row.guestName)).toEqual(["First guest"]);
  });

  it("the one who waited gets the table when the other rolls back", async () => {
    const { restaurantId, result } = await raceAgainstHolder("rollback");

    expect(result.outcome).toBe("confirmed");
    const rows = await bookingsOf(owner.db, restaurantId);
    expect(rows.map((row) => row.guestName)).toEqual(["Second guest"]);
  });

  it("moves to the next table while waiting on the first ends in a lost race", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 2 }, { capacity: 4 }],
    });
    const holder = await owner.pool.connect();
    try {
      await holder.query("begin");
      await holder.query(holdLastTable(restaurantId, tableIds[0], crypto.randomUUID().replaceAll("-", "")));
      const pid = await pidOf(holder);

      const second = confirmBooking({ restaurantId }, guest({ name: "Second guest" }), now);
      await blockedBehind(pid);
      await holder.query("commit");

      expect((await second).outcome).toBe("confirmed");
    } finally {
      holder.release(true);
    }
    const rows = await bookingsOf(owner.db, restaurantId);
    const second = rows.find((row) => row.guestName === "Second guest");
    expect(second?.tableId).toBe(tableIds[1]);
  });

  it.each([2, 2, 2, 5, 5])(
    "%i confirms for the last table, really at once: exactly one gets it",
    async (guests) => {
      const { restaurantId } = await bookableRestaurant(owner.db);

      const results = await Promise.all(
        Array.from({ length: guests }, (_, index) =>
          confirmBooking({ restaurantId }, guest({ name: `Guest ${index}` }), now),
        ),
      );

      const outcomes = results.map((result) => result.outcome).sort();
      expect(outcomes).toEqual([
        "confirmed",
        ...Array.from({ length: guests - 1 }, () => "race_lost"),
      ]);
      expect(await bookingsOf(owner.db, restaurantId)).toHaveLength(1);
    },
  );
});

describe("the list and confirm agree", () => {
  it("for every time in the day, at the same instant, whatever the reason", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 2 }, { capacity: 2, bookable: false }],
    });
    // A confirmed booking, and a completed one still inside its reset buffer.
    await owner.db.insert(bookings).values([
      aBooking(restaurantId, tableIds[0], "2026-11-06T16:00:00Z", "2026-11-06T17:00:00Z"),
      {
        ...aBooking(restaurantId, tableIds[0], "2026-11-06T18:00:00Z", "2026-11-06T18:45:00Z"),
        status: "completed",
      },
    ]);
    // 18:40 in Harare: 18:00 to 19:30 are inside the lead time as well.
    const lateNow = new Date("2026-11-06T16:40:00Z");

    const page = await getBookingPage(
      { restaurantId },
      { party: "2", date },
      lateNow,
    );
    const listed = (page.times ?? []).map((slot) => slot.time);
    expect(listed.length).toBeGreaterThan(0);

    const grid = ["18:00", "18:30", "19:00", "19:30", "20:00", "20:30", "21:00"];
    const hidden = grid.filter((time) => !listed.includes(time));
    expect(hidden.length).toBeGreaterThan(0);

    for (const time of grid) {
      const result = await confirmBooking({ restaurantId }, guest({ time }), lateNow);
      expect([time, result.outcome]).toEqual([
        time,
        // Each hidden time says why: inside the lead time, or taken.
        listed.includes(time) ? "confirmed" : time <= "19:30" ? "lead_time" : "race_lost",
      ]);
      await owner.db
        .update(bookings)
        .set({ status: "cancelled" })
        .where(and(eq(bookings.restaurantId, restaurantId), eq(bookings.guestName, "Tariro")));
    }
  });

  it("sees a booking from the night before that reaches into the first slot", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db);
    await owner.db.update(bookingSettings).set({ maxDaysAhead: 5 }).where(eq(bookingSettings.restaurantId, restaurantId));
    await owner.db
      .update(servicePeriods)
      .set({ opensAt: "12:00", lastBookingAt: "15:00" })
      .where(eq(servicePeriods.restaurantId, restaurantId));
    // Starts at 23:00 on the 5th in Harare and holds for 15 hours, to 14:00 on the
    // 6th: the date's first slots, 12:00 to 13:30, are inside it.
    await owner.db
      .insert(bookings)
      .values(aBooking(restaurantId, tableIds[0], "2026-11-05T21:00:00Z", "2026-11-06T12:00:00Z"));

    const page = await getBookingPage({ restaurantId }, { party: "2", date }, now);

    expect(page.times?.map((slot) => slot.time)).toEqual(["14:00", "14:30", "15:00"]);
  });

  it("sees the longest hold there can be, started 15 hours before the date, into its first slot", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db);
    await owner.db
      .update(servicePeriods)
      .set({ opensAt: "00:00", lastBookingAt: "02:00" })
      .where(eq(servicePeriods.restaurantId, restaurantId));
    // 09:00 on the 5th in Harare, 16 hours: the hold ends at 01:00 on the 6th.
    await owner.db
      .insert(bookings)
      .values(aBooking(restaurantId, tableIds[0], "2026-11-05T07:00:00Z", "2026-11-05T23:00:00Z"));

    const page = await getBookingPage({ restaurantId }, { party: "2", date }, now);

    expect(page.times?.map((slot) => slot.time)).toEqual(["01:00", "01:30", "02:00"]);
  });

  it("looks back exactly as far as the longest hold the settings and the database allow", () => {
    const max = (key: string) => settingFields.find((field) => field.key === key)!.max;
    expect(MAX_HOLD_MS).toBe(
      (Math.max(max("sittingMinutes"), max("largePartySittingMinutes")) + max("bufferMinutes")) *
        60_000,
    );
  });

  it("is told by the database no hold is longer than that look-back", async () => {
    const { rows } = await owner.db.execute(sql`
      select pg_get_constraintdef(oid) as definition from pg_constraint
      where conname = 'bookings_hold_capped'
    `);
    // Postgres prints the 960 minutes as '16:00:00'::interval.
    const hours = /'(\d+):00:00'::interval/.exec(String(rows[0]?.definition))?.[1];
    expect(Number(hours) * 3_600_000).toBe(MAX_HOLD_MS);
  });

  it("sees a booking on the next date that a late slot's hold would reach", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, {
      rules: { sittingMinutes: 240 },
    });
    // 00:30 on the 7th in Harare. 21:00's hold runs to 01:15.
    await owner.db
      .insert(bookings)
      .values(aBooking(restaurantId, tableIds[0], "2026-11-06T22:30:00Z", "2026-11-06T23:30:00Z"));

    const page = await getBookingPage({ restaurantId }, { party: "2", date }, now);

    expect(page.times?.map((slot) => slot.time)).toEqual(["18:00", "18:30", "19:00", "19:30", "20:00"]);
  });
});

describe("the booking page's data", () => {
  it("ignores a party or date that isn't a real choice", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db);

    for (const choice of [
      { party: "99", date },
      { party: "0", date },
      { party: "two", date },
      { party: "2", date: "2026-02-31" },
      { party: "2", date: "2026-11-04" },
      { party: "2", date: "2027-11-06" },
    ]) {
      expect((await getBookingPage({ restaurantId }, choice, now)).times).toBeUndefined();
    }
  });

  it("offers no times while booking is off", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db, { rules: { enabled: false } });

    const page = await getBookingPage({ restaurantId }, { party: "2", date }, now);

    expect(page.enabled).toBe(false);
    expect(page.times).toBeUndefined();
  });
});

describe("the day list", () => {
  it("is today on the restaurant's calendar, by time, with table and status", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 2, label: "Window" }, { capacity: 2, label: "Corner" }],
    });
    const at = (table: number, start: string, end: string, guestName: string) => ({
      ...aBooking(restaurantId, tableIds[table], start, end),
      guestName,
    });
    await owner.db.insert(bookings).values([
      at(0, "2026-11-05T21:30:00Z", "2026-11-05T21:45:00Z", "Last night"), // 23:30 on the 5th
      at(0, "2026-11-06T17:00:00Z", "2026-11-06T18:00:00Z", "Later"),
      { ...at(1, "2026-11-05T22:00:00Z", "2026-11-05T23:00:00Z", "At midnight"), status: "cancelled" },
      at(0, "2026-11-06T21:59:00Z", "2026-11-06T22:30:00Z", "Last minute"), // 23:59 on the 6th
      at(0, "2026-11-06T22:30:00Z", "2026-11-06T23:00:00Z", "Tomorrow"), // 00:30 on the 7th
    ]);

    // 00:30 on the 6th in Harare, still the 5th in UTC.
    const list = await listTodaysBookings({ restaurantId }, new Date("2026-11-05T22:30:00Z"));

    expect(list.dateLabel).toBe("Fri 6 Nov");
    expect(
      list.bookings.map(({ time, guestName, table, status, partySize }) => [
        time,
        guestName,
        table,
        status,
        partySize,
      ]),
    ).toEqual([
      ["00:00", "At midnight", "Corner", "cancelled", 2],
      ["19:00", "Later", "Window", "confirmed", 2],
      ["23:59", "Last minute", "Window", "confirmed", 2],
    ]);
  });

  it("shows nothing from another restaurant", async () => {
    const mine = await bookableRestaurant(owner.db);
    const theirs = await bookableRestaurant(owner.db);
    await owner.db
      .insert(bookings)
      .values(aBooking(theirs.restaurantId, theirs.tableIds[0], SEVEN, "2026-11-06T19:00:00Z"));

    const list = await listTodaysBookings(
      { restaurantId: mine.restaurantId },
      new Date("2026-11-06T06:00:00Z"),
    );

    expect(list.bookings).toEqual([]);
  });
});

describe("the refusals at confirm", () => {
  const confirm = (restaurantId: string, overrides: Partial<GuestRequest> = {}, at = now) =>
    confirmBooking({ restaurantId }, guest(overrides), at);

  it("refuses a party bigger than every bookable table, with the threshold, not an empty list", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 4 }, { capacity: 8, bookable: false }],
      rules: { maxOnlinePartySize: 10 },
    });

    expect(await confirm(restaurantId, { party: 5 })).toMatchObject({
      outcome: "party_too_large",
      threshold: 5,
    });
    expect((await confirm(restaurantId, { party: 4 })).outcome).toBe("confirmed");
  });

  it("refuses a time that has come inside the lead time while the page was open, with the next times", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db, { rules: { minLeadMinutes: 120 } });
    // 18:00 Harare Friday is 16:00Z; at 15:00Z the lead (two hours) reaches 17:00Z.
    const late = new Date("2026-11-06T15:00:00Z");

    const result = await confirm(restaurantId, { time: "18:30" }, late);

    expect(result).toEqual({
      outcome: "lead_time",
      times: [
        { period: "Dinner", time: "19:00" },
        { period: "Dinner", time: "19:30" },
        { period: "Dinner", time: "20:00" },
        { period: "Dinner", time: "20:30" },
      ],
    });
    expect(await bookingsOf(owner.db, restaurantId)).toEqual([]);
    // A time exactly at the end of the lead is fine.
    expect((await confirm(restaurantId, { time: "19:00" }, late)).outcome).toBe("confirmed");
  });

  it.each(["9999-12-31", "0001-01-01", "2026-11-04", "2027-11-06"])(
    "refuses the date %s as unavailable, not with an error",
    async (date) => {
      const { restaurantId } = await bookableRestaurant(owner.db);
      expect(await confirm(restaurantId, { date })).toEqual({ outcome: "date_unavailable" });
    },
  );

  it("takes today and the last bookable day", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db, {
      rules: { maxDaysAhead: 3, minLeadMinutes: 0 },
    });
    expect((await confirm(restaurantId, { date: "2026-11-08" })).outcome).toBe("confirmed");
    expect((await confirm(restaurantId, { date: "2026-11-09", phone: "+263771230002" })).outcome).toBe(
      "date_unavailable",
    );
  });

  it("refuses a phone that already holds its limit, with the count, and saves nothing more", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 2 }, { capacity: 2 }],
    });
    for (const day of ["06", "07"]) {
      await owner.db
        .insert(bookings)
        .values({
          ...aBooking(restaurantId, tableIds[0], `2026-11-${day}T10:00:00Z`, `2026-11-${day}T11:00:00Z`),
          guestPhone: "+263771234567",
        });
    }

    expect(await confirm(restaurantId)).toEqual({ outcome: "phone_limit", held: 2 });
    expect(await bookingsOf(owner.db, restaurantId)).toHaveLength(2);
    expect((await confirm(restaurantId, { phone: "+263771230009" })).outcome).toBe("confirmed");
  });

  it("doesn't count a cancelled or past booking, or another restaurant's", async () => {
    const mine = await bookableRestaurant(owner.db);
    const other = await bookableRestaurant(owner.db);
    const held = (restaurantId: string, tableId: string, day: string, status = "confirmed" as const) => ({
      ...aBooking(restaurantId, tableId, `${day}T10:00:00Z`, `${day}T11:00:00Z`),
      guestPhone: "+263771234567",
      status,
    });
    await owner.db.insert(bookings).values([
      held(mine.restaurantId, mine.tableIds[0], "2026-11-06", "cancelled" as never),
      held(mine.restaurantId, mine.tableIds[0], "2026-11-03"),
      held(other.restaurantId, other.tableIds[0], "2026-11-06"),
      held(other.restaurantId, other.tableIds[0], "2026-11-07"),
    ]);

    expect((await confirm(mine.restaurantId)).outcome).toBe("confirmed");
  });

  it("gives each refusal its own answer, never the race-lost one", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db);
    const outcomes = [
      (await confirm(restaurantId, { date: "9999-12-31" })).outcome,
      (await confirm(restaurantId, { party: 3 })).outcome,
      (await confirm(restaurantId, { time: "17:00" }, new Date("2026-11-06T16:30:00Z"))).outcome,
    ];
    expect(outcomes).toEqual(["date_unavailable", "party_too_large", "lead_time"]);
  });
});

describe("two confirms for one phone at once, through confirm", () => {
  it("lets exactly one take the phone's last place, whichever gets there first", async () => {
    // Real clock, because the trigger counts from the database's now().
    const live = new Date();
    const day = addDays(localToday(live, "Africa/Harare"), 2);
    for (let round = 0; round < 4; round++) {
      const { restaurantId } = await bookableRestaurant(owner.db, {
        tables: [{ capacity: 2 }, { capacity: 2 }],
        rules: { maxActiveBookingsPerPhone: 1, minLeadMinutes: 0 },
      });

      const results = await Promise.all(
        ["19:00", "20:00"].map((time) =>
          confirmBooking({ restaurantId }, guest({ date: day, time }), live),
        ),
      );

      expect(results.map(({ outcome }) => outcome).sort()).toEqual(["confirmed", "phone_limit"]);
      expect(await bookingsOf(owner.db, restaurantId)).toHaveLength(1);
    }
  });
});

describe("a confirm racing another for the same phone, held mid-flight", () => {
  it("waits on the other's lock, then is told the phone is full", async () => {
    const live = new Date();
    const day = addDays(localToday(live, "Africa/Harare"), 2);
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 2 }, { capacity: 2 }],
      rules: { maxActiveBookingsPerPhone: 1, minLeadMinutes: 0 },
    });
    const holder = await owner.pool.connect();
    try {
      await holder.query("begin");
      // The other confirm's insert, in but not committed: its trigger holds the phone's lock.
      await holder.query(
        `insert into bookings (restaurant_id, table_id, guest_name, guest_phone, whatsapp_opt_in,
           party_size, starts_at, ends_at, hold_ends_at, status, source, manage_token)
         values ($1, $2, 'First', '+263771234567', true, 2, $3, $4, $4, 'confirmed', 'online', $5)`,
        [
          restaurantId,
          tableIds[1],
          `${day}T10:00:00Z`,
          `${day}T11:00:00Z`,
          crypto.randomUUID().replaceAll("-", ""),
        ],
      );
      const { rows } = await holder.query("select pg_backend_pid() as pid");
      const pid = rows[0].pid as number;

      const second = confirmBooking({ restaurantId }, guest({ date: day, time: "19:00" }), live);
      await vi.waitFor(
        async () => {
          const blocked = await owner.db.execute<{ pid: number }>(sql`
            select pid from pg_stat_activity
            where ${pid} = any(pg_blocking_pids(pid)) and wait_event = 'advisory'`);
          expect(blocked.rows).toHaveLength(1);
        },
        { timeout: 5_000, interval: 20 },
      );
      await holder.query("commit");

      expect(await second).toEqual({ outcome: "phone_limit", held: 1 });
      expect(await bookingsOf(owner.db, restaurantId)).toHaveLength(1);
    } finally {
      holder.release(true);
    }
  });
});

describe("the booking page for large parties", () => {
  it("offers a final option, and says contact the restaurant for a party over every table", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 4 }],
      rules: { maxOnlinePartySize: 6 },
    });

    const page = await getBookingPage({ restaurantId }, { party: "7", date }, now);

    expect(page).toMatchObject({
      party: undefined,
      times: undefined,
      maxParty: 6,
      largeParty: { threshold: 5, contactPhone: "+263771234567", whatsappLink: "https://wa.me/263771234567" },
    });
    expect((await getBookingPage({ restaurantId }, { party: "5", date }, now)).largeParty).toMatchObject({
      threshold: 5,
    });
    expect((await getBookingPage({ restaurantId }, { party: "4", date }, now)).largeParty).toBeUndefined();
  });
});
