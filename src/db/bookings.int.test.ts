import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  aBooking,
  asTenant,
  bookableRestaurant,
  bookingsOf,
} from "../../test/integration/bookings";
import { openOwnerDatabase, openTestDatabase } from "../../test/integration/database";
import { bookings } from "./schema";

/**
 * What protects a seat with no app in the way: the rows are written straight at
 * Postgres as app_tenant, the role the app connects as.
 */
const app = openTestDatabase();
const owner = openOwnerDatabase();
afterAll(() => Promise.all([app.pool.end(), owner.pool.end()]));

const NO_OVERLAP = { cause: { code: "23P01", constraint: "bookings_no_overlap" } };

const SEVEN = "2026-11-06T17:00:00Z";
const EIGHT = "2026-11-06T18:00:00Z";
const NINE = "2026-11-06T19:00:00Z";

const insert = (row: typeof bookings.$inferInsert) =>
  asTenant(app.db, row.restaurantId, (tx) => tx.insert(bookings).values(row));

async function withOneBooking(status: "confirmed" | "seated" | "completed" | "cancelled" | "no_show") {
  const { restaurantId, tableIds } = await bookableRestaurant(owner.db);
  const [tableId] = tableIds;
  await insert({ ...aBooking(restaurantId, tableId, SEVEN, NINE), status });
  return { restaurantId, tableId };
}

describe("the exclusion constraint", () => {
  it("is the one spec 00 gives, on table and hold, for live bookings", async () => {
    const { rows } = await owner.db.execute(sql`
      select pg_get_constraintdef(oid) as definition from pg_constraint
      where conname = 'bookings_no_overlap'
    `);
    expect(rows).toEqual([
      {
        definition:
          "EXCLUDE USING gist (table_id WITH =, tstzrange(starts_at, hold_ends_at) WITH &&) " +
          "WHERE ((status = ANY (ARRAY['confirmed'::booking_status, 'seated'::booking_status, 'completed'::booking_status])))",
      },
    ]);
  });

  it.each(["confirmed", "seated", "completed"] as const)(
    "refuses an overlapping booking on a table with a %s one",
    async (status) => {
      const { restaurantId, tableId } = await withOneBooking(status);

      await expect(insert(aBooking(restaurantId, tableId, EIGHT, NINE))).rejects.toMatchObject(
        NO_OVERLAP,
      );
      expect(await bookingsOf(owner.db, restaurantId)).toHaveLength(1);
    },
  );

  it.each(["cancelled", "no_show"] as const)(
    "lets a %s booking go, so its table can be sold again",
    async (status) => {
      const { restaurantId, tableId } = await withOneBooking(status);

      await insert(aBooking(restaurantId, tableId, EIGHT, NINE));
      expect(await bookingsOf(owner.db, restaurantId)).toHaveLength(2);
    },
  );

  it("is half-open: one hold can end as the next begins", async () => {
    const { restaurantId, tableIds: [tableId] } = await bookableRestaurant(owner.db);
    await insert(aBooking(restaurantId, tableId, SEVEN, EIGHT));

    await insert(aBooking(restaurantId, tableId, EIGHT, NINE));
    expect(await bookingsOf(owner.db, restaurantId)).toHaveLength(2);
  });

  it("covers the whole hold, not just the sitting: the buffer counts", async () => {
    const { restaurantId, tableIds: [tableId] } = await bookableRestaurant(owner.db);
    await insert({
      ...aBooking(restaurantId, tableId, SEVEN, NINE),
      endsAt: new Date(EIGHT),
    });

    await expect(insert(aBooking(restaurantId, tableId, EIGHT, NINE))).rejects.toMatchObject(
      NO_OVERLAP,
    );
  });

  it("leaves another table alone", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 2 }, { capacity: 2 }],
    });
    await insert(aBooking(restaurantId, tableIds[0], SEVEN, NINE));

    await insert(aBooking(restaurantId, tableIds[1], SEVEN, NINE));
    expect(await bookingsOf(owner.db, restaurantId)).toHaveLength(2);
  });

  it("holds against a cancelled booking brought back to life", async () => {
    const { restaurantId, tableId } = await withOneBooking("cancelled");
    await insert(aBooking(restaurantId, tableId, SEVEN, NINE));

    await expect(
      asTenant(app.db, restaurantId, (tx) =>
        tx.update(bookings).set({ status: "confirmed" }).where(eq(bookings.status, "cancelled")),
      ),
    ).rejects.toMatchObject(NO_OVERLAP);
  });

  it("holds for the role that owns the tables too", async () => {
    const { restaurantId, tableId } = await withOneBooking("confirmed");

    await expect(
      owner.db.insert(bookings).values(aBooking(restaurantId, tableId, EIGHT, NINE)),
    ).rejects.toMatchObject(NO_OVERLAP);
  });
});

describe("a booking's rows", () => {
  const refused = async (
    constraint: string,
    change: Partial<typeof bookings.$inferInsert>,
  ) => {
    const { restaurantId, tableIds: [tableId] } = await bookableRestaurant(owner.db);
    await expect(
      insert({ ...aBooking(restaurantId, tableId, SEVEN, NINE), ...change }),
    ).rejects.toMatchObject({ cause: { constraint } });
  };

  it.each([
    ["a blank name", "bookings_guest_name", { guestName: "   " }],
    ["a name over 100 characters", "bookings_guest_name", { guestName: "x".repeat(101) }],
    ["a phone that isn't E.164", "bookings_guest_phone_e164", { guestPhone: "0771234567" }],
    ["a party of none", "bookings_party_size_positive", { partySize: 0 }],
    ["a note over 200 characters", "bookings_guest_note_length", { guestNote: "x".repeat(201) }],
    ["an end before the start", "bookings_times_ordered", { endsAt: new Date("2026-11-06T16:00:00Z") }],
    ["a hold that ends before the sitting", "bookings_times_ordered", { endsAt: new Date("2026-11-06T19:30:00Z") }],
    [
      "a hold over 16 hours",
      "bookings_hold_capped",
      { endsAt: new Date("2026-11-07T09:01:00Z"), holdEndsAt: new Date("2026-11-07T09:01:00Z") },
    ],
    ["a short manage token", "bookings_manage_token_shape", { manageToken: "short" }],
  ])("refuses %s", async (_what, constraint, change) => {
    await refused(constraint, change);
  });

  it("takes a hold of exactly 16 hours, the longest the availability read looks back for", async () => {
    const { restaurantId, tableIds: [tableId] } = await bookableRestaurant(owner.db);
    await insert(aBooking(restaurantId, tableId, SEVEN, "2026-11-07T09:00:00Z"));
    expect(await bookingsOf(owner.db, restaurantId)).toHaveLength(1);
  });

  it("takes a null phone, as a walk-in has", async () => {
    const { restaurantId, tableIds: [tableId] } = await bookableRestaurant(owner.db);
    await insert({ ...aBooking(restaurantId, tableId, SEVEN, NINE), guestPhone: null });
    expect(await bookingsOf(owner.db, restaurantId)).toHaveLength(1);
  });
});

describe("tenant isolation", () => {
  it("won't put a booking on another restaurant's table: the foreign key is composite", async () => {
    const mine = await bookableRestaurant(owner.db);
    const theirs = await bookableRestaurant(owner.db);

    await expect(
      insert(aBooking(mine.restaurantId, theirs.tableIds[0], SEVEN, NINE)),
    ).rejects.toMatchObject({
      cause: { constraint: "bookings_restaurant_id_table_id_tables_restaurant_id_id_fk" },
    });
  });

  it("won't write a row for another restaurant from inside this one", async () => {
    const mine = await bookableRestaurant(owner.db);
    const theirs = await bookableRestaurant(owner.db);

    await expect(
      asTenant(app.db, mine.restaurantId, (tx) =>
        tx.insert(bookings).values(aBooking(theirs.restaurantId, theirs.tableIds[0], SEVEN, NINE)),
      ),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
  });

  it("shows a tenant its own bookings and no others", async () => {
    const mine = await bookableRestaurant(owner.db);
    const theirs = await bookableRestaurant(owner.db);
    await insert(aBooking(mine.restaurantId, mine.tableIds[0], SEVEN, NINE));
    await insert(aBooking(theirs.restaurantId, theirs.tableIds[0], SEVEN, NINE));

    const rows = await asTenant(app.db, mine.restaurantId, (tx) =>
      tx.select({ restaurantId: bookings.restaurantId }).from(bookings),
    );
    expect(rows).toEqual([{ restaurantId: mine.restaurantId }]);
  });

  it("shows nothing with no tenant set", async () => {
    const mine = await bookableRestaurant(owner.db);
    await insert(aBooking(mine.restaurantId, mine.tableIds[0], SEVEN, NINE));

    expect(await app.db.select().from(bookings)).toEqual([]);
  });
});
