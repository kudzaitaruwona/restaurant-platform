import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auditLog, diningTables, platformAdmins, restaurants, servicePeriods } from "@/db/schema";
import {
  openOwnerDatabase,
  testDatabaseSettings,
} from "../../test/integration/database";
import {
  addServicePeriod,
  deleteServicePeriod,
  getBookingReadiness,
  getBookingSettings,
  listServicePeriods,
  setBookingEnabled,
  updateBookingSettings,
  updateServicePeriod,
} from "./booking-settings";

vi.mock("next/cache", () => ({ revalidateTag: () => {} }));

/** Runs as app_tenant, so everything here also holds under RLS. */
const owner = openOwnerDatabase();
const created: string[] = [];

async function newRestaurant(extra: Partial<typeof restaurants.$inferInsert> = {}) {
  const restaurantId = crypto.randomUUID();
  await owner.db.insert(restaurants).values({
    id: restaurantId,
    name: "Mama's Kitchen",
    slug: `booking-lib-${restaurantId}`,
    menuToken: `booking-lib-${restaurantId}`,
    currencyMode: "usd_only",
    ...extra,
  });
  created.push(restaurantId);
  return { restaurantId };
}

const token = () => crypto.randomUUID().replaceAll("-", "").slice(0, 22).padEnd(22, "x");

const addTable = (restaurantId: string, values: Partial<typeof diningTables.$inferInsert> = {}) =>
  owner.db.insert(diningTables).values({
    restaurantId,
    label: crypto.randomUUID(),
    capacity: 4,
    qrToken: token(),
    ...values,
  });

const lunch = { name: "Lunch", weekday: 1, opensAt: "12:00", lastBookingAt: "14:00", closesAt: "15:00" };
const dinner = { name: "Dinner", weekday: 1, opensAt: "18:00", lastBookingAt: "21:00", closesAt: "22:00" };

beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});

afterAll(async () => {
  await owner.db.delete(auditLog).where(inArray(auditLog.restaurantId, created));
  await owner.db.delete(servicePeriods).where(inArray(servicePeriods.restaurantId, created));
  await owner.db.delete(diningTables).where(inArray(diningTables.restaurantId, created));
  await owner.db.delete(restaurants).where(inArray(restaurants.id, created));
  await owner.pool.end();
  vi.unstubAllEnvs();
});

const anAdmin = async () => {
  const [admin] = await owner.db.select({ id: platformAdmins.id }).from(platformAdmins).limit(1);
  return admin;
};

const ownerOf = ({ restaurantId }: { restaurantId: string }) => ({
  restaurantId,
  platformAdminId: undefined,
});

describe("the settings", () => {
  it("start at spec 00's defaults, with booking off", async () => {
    const restaurant = await newRestaurant();

    expect(await getBookingSettings(restaurant)).toEqual({
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

  it("can all be edited, and an edit leaves booking as it was", async () => {
    const restaurant = await newRestaurant();
    const values = {
      slotIntervalMinutes: 30,
      sittingMinutes: 75,
      largePartySize: 6,
      largePartySittingMinutes: 150,
      bufferMinutes: 10,
      minLeadMinutes: 120,
      maxDaysAhead: 60,
      maxOnlinePartySize: 10,
      guestCancelCutoffMinutes: 240,
      maxActiveBookingsPerPhone: 3,
    };

    await updateBookingSettings(ownerOf(restaurant), values);

    expect(await getBookingSettings(restaurant)).toEqual({ enabled: false, ...values });
  });

  it("are one restaurant's: another's stay as they were", async () => {
    const [mine, theirs] = [await newRestaurant(), await newRestaurant()];

    await updateBookingSettings(ownerOf(mine), {
      ...(await getBookingSettings(mine)),
      sittingMinutes: 45,
    });

    expect((await getBookingSettings(theirs)).sittingMinutes).toBe(90);
  });

  it("are audited only for a platform admin: spec 01's audit list leaves settings out", async () => {
    const restaurant = await newRestaurant();
    const values = await getBookingSettings(restaurant);

    await updateBookingSettings(ownerOf(restaurant), values);
    const admin = await anAdmin();
    await updateBookingSettings({ ...restaurant, platformAdminId: admin.id }, values);

    const entries = await owner.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.restaurantId, restaurant.restaurantId));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: "booking_settings.update",
      actorType: "platform_admin",
    });
  });
});

describe("service periods", () => {
  it("can be several per weekday, listed by day and opening time with times as HH:MM", async () => {
    const restaurant = await newRestaurant();
    await addServicePeriod(ownerOf(restaurant), { ...dinner });
    await addServicePeriod(ownerOf(restaurant), { ...lunch });
    await addServicePeriod(ownerOf(restaurant), { ...lunch, weekday: 0 });

    const periods = await listServicePeriods(restaurant);

    expect(periods.map(({ name, weekday, opensAt, lastBookingAt, closesAt }) => ({ name, weekday, opensAt, lastBookingAt, closesAt }))).toEqual([
      { ...lunch, weekday: 0 },
      lunch,
      dinner,
    ]);
  });

  it("can't overlap another on the same weekday", async () => {
    const restaurant = await newRestaurant();
    await addServicePeriod(ownerOf(restaurant), lunch);

    expect(
      await addServicePeriod(ownerOf(restaurant), {
        ...lunch,
        name: "Brunch",
        opensAt: "11:00",
        lastBookingAt: "12:30",
        closesAt: "13:00",
      }),
    ).toBe("overlaps");
    expect(await listServicePeriods(restaurant)).toHaveLength(1);
  });

  it("can touch: one closes as the next opens", async () => {
    const restaurant = await newRestaurant();
    await addServicePeriod(ownerOf(restaurant), lunch);

    expect(
      await addServicePeriod(ownerOf(restaurant), {
        ...lunch,
        name: "Afternoon",
        opensAt: "15:00",
        lastBookingAt: "16:00",
        closesAt: "17:00",
      }),
    ).toBe("saved");
  });

  it("is refused, whatever the app checked, when the database sees times out of order", async () => {
    const restaurant = await newRestaurant();

    expect(
      await addServicePeriod(ownerOf(restaurant), { ...lunch, lastBookingAt: "15:00" }),
    ).toBe("invalid_times");
  });

  it("can be edited, but not into an overlap, and not in another restaurant", async () => {
    const [mine, theirs] = [await newRestaurant(), await newRestaurant()];
    await addServicePeriod(ownerOf(mine), lunch);
    await addServicePeriod(ownerOf(mine), dinner);
    const [, evening] = await listServicePeriods(mine);

    expect(
      await updateServicePeriod(ownerOf(mine), evening.id, {
        name: "Late lunch",
        opensAt: "14:00",
        lastBookingAt: "14:30",
        closesAt: "16:00",
      }),
    ).toBe("overlaps");
    expect(
      await updateServicePeriod(ownerOf(mine), evening.id, {
        name: "Supper",
        opensAt: "19:00",
        lastBookingAt: "21:30",
        closesAt: "23:00",
      }),
    ).toBe("saved");
    expect((await listServicePeriods(mine))[1]).toMatchObject({ name: "Supper", opensAt: "19:00" });
    expect(
      await updateServicePeriod(ownerOf(theirs), evening.id, {
        name: "Hijacked",
        opensAt: "10:00",
        lastBookingAt: "11:00",
        closesAt: "12:00",
      }),
    ).toBe("not_found");
    expect((await listServicePeriods(mine))[1].name).toBe("Supper");
  });

  it("can be deleted, but only from its own restaurant", async () => {
    const [mine, theirs] = [await newRestaurant(), await newRestaurant()];
    await addServicePeriod(ownerOf(mine), lunch);
    const [period] = await listServicePeriods(mine);

    expect(await deleteServicePeriod(ownerOf(theirs), period.id)).toBe("not_found");
    expect(await listServicePeriods(mine)).toHaveLength(1);
    expect(await deleteServicePeriod(ownerOf(mine), period.id)).toBe("saved");
    expect(await listServicePeriods(mine)).toEqual([]);
    expect(await deleteServicePeriod(ownerOf(mine), period.id)).toBe("not_found");
  });
});

describe("turning online booking on", () => {
  it("is blocked until there's a period, a bookable table and a contact phone, and says which", async () => {
    const restaurant = await newRestaurant();

    expect(await setBookingEnabled(ownerOf(restaurant), true)).toEqual({
      outcome: "blocked",
      missing: ["service_period", "table", "contact_phone"],
    });

    await addServicePeriod(ownerOf(restaurant), lunch);
    expect(await setBookingEnabled(ownerOf(restaurant), true)).toEqual({
      outcome: "blocked",
      missing: ["table", "contact_phone"],
    });

    await addTable(restaurant.restaurantId);
    expect(await setBookingEnabled(ownerOf(restaurant), true)).toEqual({
      outcome: "blocked",
      missing: ["contact_phone"],
    });
    expect((await getBookingSettings(restaurant)).enabled).toBe(false);

    await owner.db
      .update(restaurants)
      .set({ contactPhone: "+263771234567" })
      .where(eq(restaurants.id, restaurant.restaurantId));
    expect(await setBookingEnabled(ownerOf(restaurant), true)).toEqual({ outcome: "saved" });
    expect((await getBookingSettings(restaurant)).enabled).toBe(true);
  });

  it("ignores a table that is walk-ins only or archived", async () => {
    const restaurant = await newRestaurant({ contactPhone: "+263771234567" });
    await addServicePeriod(ownerOf(restaurant), lunch);
    await addTable(restaurant.restaurantId, { bookable: false });
    await addTable(restaurant.restaurantId, { archivedAt: new Date() });

    expect(await setBookingEnabled(ownerOf(restaurant), true)).toEqual({
      outcome: "blocked",
      missing: ["table"],
    });
  });

  it("can always be turned off", async () => {
    const restaurant = await newRestaurant();

    expect(await setBookingEnabled(ownerOf(restaurant), false)).toEqual({ outcome: "saved" });
  });

  it("is switched off again by deleting the last period", async () => {
    const restaurant = await newRestaurant({ contactPhone: "+263771234567" });
    await addServicePeriod(ownerOf(restaurant), lunch);
    await addTable(restaurant.restaurantId);
    await setBookingEnabled(ownerOf(restaurant), true);
    const [period] = await listServicePeriods(restaurant);

    await deleteServicePeriod(ownerOf(restaurant), period.id);

    expect((await getBookingSettings(restaurant)).enabled).toBe(false);
  });

  it("is audited for a platform admin, as enable and disable", async () => {
    const restaurant = await newRestaurant({ contactPhone: "+263771234567" });
    await addServicePeriod(ownerOf(restaurant), lunch);
    await addTable(restaurant.restaurantId);
    const admin = { ...restaurant, platformAdminId: (await anAdmin()).id };

    await setBookingEnabled(admin, true);
    await setBookingEnabled(admin, false);

    const entries = await owner.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.restaurantId, restaurant.restaurantId));
    expect(entries.map((entry) => entry.action).sort()).toEqual(["booking.disable", "booking.enable"]);
  });
});

describe("the readiness the screen lists", () => {
  it("counts live bookable tables and gives the phone and timezone", async () => {
    const restaurant = await newRestaurant({ contactPhone: "+263771234567", timezone: "Africa/Johannesburg" });
    await addTable(restaurant.restaurantId);
    await addTable(restaurant.restaurantId, { bookable: false });
    await addTable(restaurant.restaurantId, { archivedAt: new Date() });

    expect(await getBookingReadiness(restaurant)).toEqual({
      bookableTables: 1,
      contactPhone: "+263771234567",
      timezone: "Africa/Johannesburg",
    });
  });

  it("is only its own restaurant's", async () => {
    const [mine, theirs] = [await newRestaurant(), await newRestaurant()];
    await addTable(theirs.restaurantId);

    expect((await getBookingReadiness(mine)).bookableTables).toBe(0);
  });
});
