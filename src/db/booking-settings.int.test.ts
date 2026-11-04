import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  openOwnerDatabase,
  openTestDatabase,
} from "../../test/integration/database";
import { bookingSettings, diningTables, restaurants, servicePeriods } from "./schema";

/**
 * What Postgres itself guarantees about booking settings and service periods,
 * whatever the app does. Runs as the owner role, which RLS skips, so a refusal
 * here comes from a constraint or trigger and not from a policy.
 */
const owner = openOwnerDatabase();
const app = openTestDatabase();

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const EXCLUSION_VIOLATION = "23P01";

const created: string[] = [];

async function newRestaurant(contactPhone: string | null = "+263771234567") {
  const id = crypto.randomUUID();
  await owner.db.insert(restaurants).values({
    id,
    name: "Booking settings",
    slug: `booking-settings-${id}`,
    menuToken: `booking-settings-${id}`,
    currencyMode: "usd_only",
    contactPhone,
  });
  created.push(id);
  return id;
}

afterAll(async () => {
  for (const id of created) {
    await owner.db.delete(servicePeriods).where(eq(servicePeriods.restaurantId, id));
    await owner.db.delete(diningTables).where(eq(diningTables.restaurantId, id));
    await owner.db.delete(restaurants).where(eq(restaurants.id, id));
  }
  await Promise.all([owner.pool.end(), app.pool.end()]);
});

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: { cause?: { code?: string } }) => error.cause?.code,
  );

const constraint = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: { cause?: { constraint?: string; detail?: string } }) => ({
      constraint: error.cause?.constraint,
      detail: error.cause?.detail,
    }),
  );

const token = () => crypto.randomUUID().replaceAll("-", "").slice(0, 22).padEnd(22, "x");

const addTable = async (
  restaurantId: string,
  values: Partial<typeof diningTables.$inferInsert> = {},
) => {
  const id = crypto.randomUUID();
  await owner.db.insert(diningTables).values({
    id,
    restaurantId,
    label: id,
    capacity: 4,
    qrToken: token(),
    ...values,
  });
  return id;
};

const period = (
  restaurantId: string,
  values: Partial<typeof servicePeriods.$inferInsert> = {},
) => ({
  restaurantId,
  name: "Lunch",
  weekday: 1,
  opensAt: "12:00",
  lastBookingAt: "14:00",
  closesAt: "15:00",
  ...values,
});

const addPeriod = (restaurantId: string, values: Partial<typeof servicePeriods.$inferInsert> = {}) =>
  owner.db
    .insert(servicePeriods)
    .values(period(restaurantId, values))
    .returning({ id: servicePeriods.id })
    .then(([row]) => row.id);

const settingsOf = async (restaurantId: string) => {
  const rows = await owner.db
    .select()
    .from(bookingSettings)
    .where(eq(bookingSettings.restaurantId, restaurantId));
  return rows;
};

const enable = (restaurantId: string) =>
  owner.db
    .update(bookingSettings)
    .set({ enabled: true })
    .where(eq(bookingSettings.restaurantId, restaurantId));

const isEnabled = async (restaurantId: string) => (await settingsOf(restaurantId))[0].enabled;

/** A restaurant that can take bookings: a period, a bookable table and a phone. */
async function readyRestaurant() {
  const restaurantId = await newRestaurant();
  const periodId = await addPeriod(restaurantId);
  const tableId = await addTable(restaurantId);
  return { restaurantId, periodId, tableId };
}

describe("one booking_settings row per restaurant", () => {
  it("is made with the restaurant, with spec 00's defaults", async () => {
    const restaurantId = await newRestaurant();

    const rows = await settingsOf(restaurantId);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      enabled: false,
      slotIntervalMinutes: 15,
      sittingMinutes: 90,
      largePartySize: 5,
      largePartySittingMinutes: 120,
      bufferMinutes: 15,
      minLeadMinutes: 60,
      maxDaysAhead: 30,
      maxOnlinePartySize: 8,
      guestCancelCutoffMinutes: 120,
      maxActiveBookingsPerPhone: 2,
    });
  });

  it("exists for the seeded restaurants too", async () => {
    const { rows } = await owner.db.execute(sql`
      select count(*)::int as missing from restaurants r
      where not exists (select from booking_settings b where b.restaurant_id = r.id)
    `);
    expect(rows).toEqual([{ missing: 0 }]);
  });

  it("is the only one: a second is refused", async () => {
    const restaurantId = await newRestaurant();

    expect(await code(owner.db.insert(bookingSettings).values({ restaurantId }))).toBe(
      UNIQUE_VIOLATION,
    );
  });

  it("goes with its restaurant", async () => {
    const restaurantId = await newRestaurant();
    await owner.db.delete(restaurants).where(eq(restaurants.id, restaurantId));

    expect(await settingsOf(restaurantId)).toEqual([]);
  });

  it.each([
    ["slotIntervalMinutes", 0],
    ["sittingMinutes", 0],
    ["largePartySize", 0],
    ["largePartySittingMinutes", 0],
    ["bufferMinutes", -1],
    ["minLeadMinutes", -1],
    ["maxDaysAhead", -1],
    ["maxOnlinePartySize", 0],
    ["guestCancelCutoffMinutes", -1],
    ["maxActiveBookingsPerPhone", 0],
    ["slotIntervalMinutes", 241],
    ["maxDaysAhead", 366],
    ["maxOnlinePartySize", 101],
    ["maxActiveBookingsPerPhone", 21],
  ] as const)("refuses %s = %d", async (field, value) => {
    const restaurantId = await newRestaurant();

    expect(
      await code(
        owner.db
          .update(bookingSettings)
          .set({ [field]: value })
          .where(eq(bookingSettings.restaurantId, restaurantId)),
      ),
    ).toBe(CHECK_VIOLATION);
  });
});

describe("a service period's times", () => {
  it.each([
    ["opens before the last booking and the last booking before closing", "12:00", "14:00", "15:00"],
    ["may open and take its last booking at the same minute", "12:00", "12:00", "15:00"],
    ["may close at 23:59", "18:00", "22:00", "23:59"],
  ])("%s", async (_name, opensAt, lastBookingAt, closesAt) => {
    const restaurantId = await newRestaurant();

    await expect(
      addPeriod(restaurantId, { opensAt, lastBookingAt, closesAt }),
    ).resolves.toEqual(expect.any(String));
  });

  it.each([
    ["opens after the last booking", "15:00", "14:00", "16:00"],
    ["has its last booking at closing time", "12:00", "15:00", "15:00"],
    ["has its last booking after closing", "12:00", "16:00", "15:00"],
    ["closes before it opens (crossing midnight)", "20:00", "22:00", "01:00"],
    ["closes at midnight", "20:00", "22:00", "24:00"],
    ["closes after 23:59", "20:00", "22:00", "23:59:30"],
  ])("refuses one that %s", async (_name, opensAt, lastBookingAt, closesAt) => {
    const restaurantId = await newRestaurant();

    expect(await code(addPeriod(restaurantId, { opensAt, lastBookingAt, closesAt }))).toBe(
      CHECK_VIOLATION,
    );
  });

  it.each([-1, 7])("refuses weekday %d", async (weekday) => {
    const restaurantId = await newRestaurant();

    expect(await code(addPeriod(restaurantId, { weekday }))).toBe(CHECK_VIOLATION);
  });

  it.each(["", "   ", "x".repeat(51)])("refuses the name %j", async (name) => {
    const restaurantId = await newRestaurant();

    expect(await code(addPeriod(restaurantId, { name }))).toBe(CHECK_VIOLATION);
  });
});

describe("two periods on one weekday", () => {
  it("can't overlap", async () => {
    const restaurantId = await newRestaurant();
    await addPeriod(restaurantId, { opensAt: "12:00", lastBookingAt: "14:00", closesAt: "15:00" });

    expect(
      await constraint(
        addPeriod(restaurantId, { opensAt: "14:30", lastBookingAt: "16:00", closesAt: "17:00" }),
      ),
    ).toMatchObject({ constraint: "service_periods_no_overlap" });
  });

  it("can't overlap even when one holds the other", async () => {
    const restaurantId = await newRestaurant();
    await addPeriod(restaurantId, { opensAt: "12:00", lastBookingAt: "14:00", closesAt: "15:00" });

    expect(
      await code(
        addPeriod(restaurantId, { opensAt: "12:30", lastBookingAt: "13:00", closesAt: "14:00" }),
      ),
    ).toBe(EXCLUSION_VIOLATION);
  });

  it("can touch: the first closes the minute the second opens", async () => {
    const restaurantId = await newRestaurant();
    await addPeriod(restaurantId, { opensAt: "12:00", lastBookingAt: "14:00", closesAt: "15:00" });

    await expect(
      addPeriod(restaurantId, { opensAt: "15:00", lastBookingAt: "16:00", closesAt: "17:00" }),
    ).resolves.toEqual(expect.any(String));
  });

  it("can be at the same hours on another weekday", async () => {
    const restaurantId = await newRestaurant();
    await addPeriod(restaurantId, { weekday: 1 });

    await expect(addPeriod(restaurantId, { weekday: 2 })).resolves.toEqual(expect.any(String));
  });

  it("can be at the same hours in another restaurant", async () => {
    const [mine, theirs] = [await newRestaurant(), await newRestaurant()];
    await addPeriod(mine);

    await expect(addPeriod(theirs)).resolves.toEqual(expect.any(String));
  });

  it("can't be made to overlap by moving one", async () => {
    const restaurantId = await newRestaurant();
    await addPeriod(restaurantId, { opensAt: "12:00", lastBookingAt: "14:00", closesAt: "15:00" });
    const dinner = await addPeriod(restaurantId, {
      name: "Dinner",
      opensAt: "18:00",
      lastBookingAt: "21:00",
      closesAt: "22:00",
    });

    expect(
      await code(
        owner.db
          .update(servicePeriods)
          .set({ opensAt: "14:00", lastBookingAt: "14:30" })
          .where(eq(servicePeriods.id, dinner)),
      ),
    ).toBe(EXCLUSION_VIOLATION);
  });
});

describe("the enable gate", () => {
  it("refuses to enable a restaurant with nothing set up, naming everything missing", async () => {
    const restaurantId = await newRestaurant(null);

    expect(await constraint(enable(restaurantId))).toEqual({
      constraint: "booking_settings_enable_gate",
      detail: "service_period,table,contact_phone",
    });
    expect(await isEnabled(restaurantId)).toBe(false);
  });

  it.each([
    ["a service period", "service_period", async (id: string) => { await addTable(id); }],
    ["a bookable table", "table", async (id: string) => { await addPeriod(id); }],
  ])("refuses without %s", async (_name, missing, setUp) => {
    const restaurantId = await newRestaurant();
    await setUp(restaurantId);

    expect(await constraint(enable(restaurantId))).toEqual({
      constraint: "booking_settings_enable_gate",
      detail: missing,
    });
  });

  it("refuses without a contact phone", async () => {
    const restaurantId = await newRestaurant(null);
    await addPeriod(restaurantId);
    await addTable(restaurantId);

    expect(await constraint(enable(restaurantId))).toEqual({
      constraint: "booking_settings_enable_gate",
      detail: "contact_phone",
    });
  });

  it("doesn't count a table that is archived or walk-ins only", async () => {
    const restaurantId = await newRestaurant();
    await addPeriod(restaurantId);
    await addTable(restaurantId, { archivedAt: new Date() });
    await addTable(restaurantId, { bookable: false });

    expect(await constraint(enable(restaurantId))).toMatchObject({ detail: "table" });
  });

  it("refuses a settings row inserted already enabled", async () => {
    const restaurantId = await newRestaurant(null);
    await owner.db.delete(bookingSettings).where(eq(bookingSettings.restaurantId, restaurantId));

    expect(
      await constraint(owner.db.insert(bookingSettings).values({ restaurantId, enabled: true })),
    ).toMatchObject({ constraint: "booking_settings_enable_gate" });
  });

  it("lets a restaurant with all three turn booking on", async () => {
    const { restaurantId } = await readyRestaurant();

    await enable(restaurantId);

    expect(await isEnabled(restaurantId)).toBe(true);
  });

  it("holds for the app role under RLS, which is who enables it", async () => {
    const restaurantId = await newRestaurant(null);

    const attempt = app.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.restaurant_id', ${restaurantId}, true)`);
      await tx.update(bookingSettings).set({ enabled: true });
    });

    expect(await constraint(attempt)).toMatchObject({
      constraint: "booking_settings_enable_gate",
    });
  });

  it("isn't asked again when something else on the row changes", async () => {
    const { restaurantId } = await readyRestaurant();
    await enable(restaurantId);

    await owner.db
      .update(bookingSettings)
      .set({ sittingMinutes: 60 })
      .where(eq(bookingSettings.restaurantId, restaurantId));

    expect(await isEnabled(restaurantId)).toBe(true);
  });
});

describe("booking switches itself off when the gate stops holding", () => {
  it("when the last bookable table is archived", async () => {
    const { restaurantId, tableId } = await readyRestaurant();
    await enable(restaurantId);

    await owner.db
      .update(diningTables)
      .set({ archivedAt: new Date() })
      .where(eq(diningTables.id, tableId));

    expect(await isEnabled(restaurantId)).toBe(false);
  });

  it("when the last bookable table becomes walk-ins only", async () => {
    const { restaurantId, tableId } = await readyRestaurant();
    await enable(restaurantId);

    await owner.db
      .update(diningTables)
      .set({ bookable: false })
      .where(eq(diningTables.id, tableId));

    expect(await isEnabled(restaurantId)).toBe(false);
  });

  it("when the last service period is deleted", async () => {
    const { restaurantId, periodId } = await readyRestaurant();
    await enable(restaurantId);

    await owner.db.delete(servicePeriods).where(eq(servicePeriods.id, periodId));

    expect(await isEnabled(restaurantId)).toBe(false);
  });

  it("when the contact phone is cleared", async () => {
    const { restaurantId } = await readyRestaurant();
    await enable(restaurantId);

    await owner.db
      .update(restaurants)
      .set({ contactPhone: null })
      .where(eq(restaurants.id, restaurantId));

    expect(await isEnabled(restaurantId)).toBe(false);
  });

  it("but not while another bookable table, period and the phone remain", async () => {
    const { restaurantId, tableId, periodId } = await readyRestaurant();
    await addTable(restaurantId);
    await addPeriod(restaurantId, { name: "Dinner", opensAt: "18:00", lastBookingAt: "21:00", closesAt: "22:00" });
    await enable(restaurantId);

    await owner.db.update(diningTables).set({ archivedAt: new Date() }).where(eq(diningTables.id, tableId));
    await owner.db.delete(servicePeriods).where(eq(servicePeriods.id, periodId));
    await owner.db.update(restaurants).set({ contactPhone: "+263771234568" }).where(eq(restaurants.id, restaurantId));

    expect(await isEnabled(restaurantId)).toBe(true);
  });

  it("and leaves a restaurant that never enabled alone", async () => {
    const { restaurantId, tableId } = await readyRestaurant();

    await owner.db.update(diningTables).set({ archivedAt: new Date() }).where(eq(diningTables.id, tableId));

    expect(await isEnabled(restaurantId)).toBe(false);
  });
});

describe("enabling while the last bookable table is archived", () => {
  let waiting: ReturnType<typeof setTimeout> | undefined;
  afterAll(() => clearTimeout(waiting));

  /** Resolves once some backend is blocked on a lock, which is the interleaving under test. */
  async function untilSomeoneWaitsOnALock() {
    for (let attempt = 0; attempt < 200; attempt++) {
      const { rows } = await owner.db.execute(sql`
        select 1 from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
      `);
      if (rows.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("nothing ever waited on a lock");
  }

  it("enable commits first: the archive then switches booking off", async () => {
    const { restaurantId, tableId } = await readyRestaurant();
    const enabler = await owner.pool.connect();
    const archiver = await owner.pool.connect();
    try {
      await enabler.query("begin");
      await enabler.query("update booking_settings set enabled = true where restaurant_id = $1", [
        restaurantId,
      ]);
      // The gate passed: the table is still live as far as the enabler can see.
      await archiver.query("begin");
      const archiving = archiver
        .query("update tables set archived_at = now() where id = $1", [tableId])
        .then(() => archiver.query("commit"));
      await untilSomeoneWaitsOnALock();

      await enabler.query("commit");
      await archiving;

      expect(await isEnabled(restaurantId)).toBe(false);
    } finally {
      enabler.release();
      archiver.release();
    }
  });

  it("archive commits first: the enable is then refused", async () => {
    const { restaurantId, tableId } = await readyRestaurant();
    const enabler = await owner.pool.connect();
    const archiver = await owner.pool.connect();
    try {
      await archiver.query("begin");
      await archiver.query("update tables set archived_at = now() where id = $1", [tableId]);
      await enabler.query("begin");
      const enabling = enabler
        .query("update booking_settings set enabled = true where restaurant_id = $1", [restaurantId])
        .then(
          () => undefined,
          (error: { constraint?: string }) => error.constraint,
        );
      // The archive took the settings row's lock in its trigger, so the enable queues behind it.
      await untilSomeoneWaitsOnALock();

      await archiver.query("commit");

      expect(await enabling).toBe("booking_settings_enable_gate");
      await enabler.query("rollback");
      expect(await isEnabled(restaurantId)).toBe(false);
    } finally {
      enabler.release();
      archiver.release();
    }
  });
});
