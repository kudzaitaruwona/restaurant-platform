import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  openAdminDatabase,
  openOwnerDatabase,
  openTestDatabase,
} from "../../test/integration/database";
import { devPlatformAdmin, devRestaurants } from "../lib/tenant/dev-identities";
import {
  auditLog,
  bookingSettings,
  categories,
  diningTables,
  exchangeRates,
  menuItems,
  onboardingChecklist,
  restaurants,
  servicePeriods,
  platformAdmins,
  staff,
} from "./schema";

/**
 * The onboarding checklist (spec 01), through the privileged path: app_admin
 * reads and ticks it through platform_* functions alone (S-28).
 */
const admin = openAdminDatabase();
const app = openTestDatabase();
const owner = openOwnerDatabase();
afterAll(() => Promise.all([admin.pool.end(), app.pool.end(), owner.pool.end()]));

const adminId: string = devPlatformAdmin.platformAdminId;
const [restaurantA, restaurantB] = devRestaurants.map(({ id }) => id);

const INSUFFICIENT_PRIVILEGE = "42501";
const NO_DATA_FOUND = "P0002";
const failsWith = (call: Promise<unknown>, code: string) =>
  expect(call).rejects.toMatchObject({ cause: { code } });

const checklistSql = (actor = adminId) =>
  sql`select * from platform_onboarding_checklist(${actor})`;
const tickSql = (restaurantId: string, printed: boolean, actor = adminId) =>
  sql`select platform_set_qr_codes_printed(${actor}, ${restaurantId}, ${printed})`;

type Row = {
  restaurant_id: string;
  menu_entered: boolean;
  photos: boolean;
  exchange_rate_set: boolean;
  tables_added: boolean;
  qr_codes_printed: boolean;
  qr_codes_printed_at: string | null;
  booking_hours_set: boolean;
  booking_enabled: boolean;
};

async function checklistOf(restaurantId: string) {
  const { rows } = await admin.db.execute<Row>(checklistSql());
  return rows.find((row) => row.restaurant_id === restaurantId);
}

async function newRestaurant() {
  const { rows } = await admin.db.execute<{ id: string }>(
    sql`select platform_create_restaurant(${adminId}, 'Checklist', ${`checklist-${crypto.randomUUID()}`}, 'Africa/Harare', 'both') as id`,
  );
  return rows[0].id;
}

/** A restaurant with one staff row, which an exchange rate needs for set_by. */
async function restaurantWithStaff() {
  const id = await newRestaurant();
  const [member] = await owner.db
    .insert(staff)
    .values({ restaurantId: id, displayName: "Shadow", kind: "platform_admin", role: "owner" })
    .returning();
  return { id, staffId: member.id };
}

async function addItem(restaurantId: string, photoKey: string | null = null) {
  const [category] = await owner.db
    .insert(categories)
    .values({ restaurantId, name: "Mains" })
    .returning();
  const [item] = await owner.db
    .insert(menuItems)
    .values({ restaurantId, categoryId: category.id, name: "Sadza", priceUsd: "3", photoKey })
    .returning();
  return item;
}

describe("platform_onboarding_checklist", () => {
  it("starts a new restaurant with everything undone", async () => {
    const id = await newRestaurant();
    expect(await checklistOf(id)).toEqual({
      restaurant_id: id,
      menu_entered: false,
      photos: false,
      exchange_rate_set: false,
      tables_added: false,
      qr_codes_printed: false,
      qr_codes_printed_at: null,
      booking_hours_set: false,
      booking_enabled: false,
    });
  });

  it("lists every restaurant, across tenants", async () => {
    const { rows } = await admin.db.execute<Row>(checklistSql());
    const ids = rows.map((row) => row.restaurant_id);
    expect(ids).toEqual(expect.arrayContaining([restaurantA, restaurantB]));
  });

  it("derives menu entered from a live item, and photos from a live item with a photo", async () => {
    const id = await newRestaurant();
    const item = await addItem(id);
    expect(await checklistOf(id)).toMatchObject({ menu_entered: true, photos: false });

    await owner.db.update(menuItems).set({ photoKey: "k/abc" }).where(eq(menuItems.id, item.id));
    expect(await checklistOf(id)).toMatchObject({ menu_entered: true, photos: true });

    await owner.db
      .update(menuItems)
      .set({ archivedAt: new Date() })
      .where(eq(menuItems.id, item.id));
    expect(await checklistOf(id)).toMatchObject({ menu_entered: false, photos: false });
  });

  it("derives exchange rate set from the rate history", async () => {
    const { id, staffId } = await restaurantWithStaff();
    expect((await checklistOf(id))?.exchange_rate_set).toBe(false);

    await owner.db
      .insert(exchangeRates)
      .values({ restaurantId: id, usdToZig: "27", setBy: staffId });

    expect((await checklistOf(id))?.exchange_rate_set).toBe(true);
  });

  it("derives tables added from a live table, not an archived one", async () => {
    const id = await newRestaurant();
    const [table] = await owner.db
      .insert(diningTables)
      .values({ restaurantId: id, label: "1", capacity: 2, qrToken: "a".repeat(22) + crypto.randomUUID().replaceAll("-", "") })
      .returning();
    expect((await checklistOf(id))?.tables_added).toBe(true);

    await owner.db
      .update(diningTables)
      .set({ archivedAt: new Date() })
      .where(eq(diningTables.id, table.id));
    expect((await checklistOf(id))?.tables_added).toBe(false);
  });

  it("derives booking hours set from a service period, and booking enabled from the setting", async () => {
    const id = await newRestaurant();
    await owner.db.insert(servicePeriods).values({
      restaurantId: id,
      name: "Dinner",
      weekday: 1,
      opensAt: "17:00",
      lastBookingAt: "21:00",
      closesAt: "22:00",
    });
    await owner.db.insert(diningTables).values({
      restaurantId: id,
      label: "1",
      capacity: 2,
      qrToken: "b".repeat(22) + crypto.randomUUID().replaceAll("-", ""),
    });
    await owner.db
      .update(restaurants)
      .set({ contactPhone: "+263771234567" })
      .where(eq(restaurants.id, id));
    expect(await checklistOf(id)).toMatchObject({
      booking_hours_set: true,
      booking_enabled: false,
    });

    await owner.db
      .update(bookingSettings)
      .set({ enabled: true })
      .where(eq(bookingSettings.restaurantId, id));

    expect(await checklistOf(id)).toMatchObject({
      booking_hours_set: true,
      booking_enabled: true,
    });
  });

  it("never counts a usd_only restaurant's exchange rate as set, since none is needed (proposed, see spec 01)", async () => {
    const { rows } = await admin.db.execute<{ id: string }>(
      sql`select platform_create_restaurant(${adminId}, 'UsdOnly', ${`usd-${crypto.randomUUID()}`}, 'Africa/Harare', 'usd_only') as id`,
    );
    expect((await checklistOf(rows[0].id))?.exchange_rate_set).toBe(false);
  });

  it("refuses an id that isn't a platform admin's", async () => {
    await failsWith(admin.db.execute(checklistSql(crypto.randomUUID())), INSUFFICIENT_PRIVILEGE);
  });

  it("can't be called as app_tenant", async () => {
    await failsWith(app.db.execute(checklistSql()), INSUFFICIENT_PRIVILEGE);
  });
});

describe("platform_set_qr_codes_printed", () => {
  const auditOf = (restaurantId: string) =>
    owner.db.select().from(auditLog).where(eq(auditLog.restaurantId, restaurantId));

  it("ticks, and the tick persists across reads", async () => {
    const id = await newRestaurant();

    await admin.db.execute(tickSql(id, true));

    const first = await checklistOf(id);
    const second = await checklistOf(id);
    expect(first).toMatchObject({ qr_codes_printed: true });
    expect(first?.qr_codes_printed_at).toEqual(expect.any(String));
    expect(second).toEqual(first);
  });

  it("unticks", async () => {
    const id = await newRestaurant();
    await admin.db.execute(tickSql(id, true));

    await admin.db.execute(tickSql(id, false));

    expect(await checklistOf(id)).toMatchObject({
      qr_codes_printed: false,
      qr_codes_printed_at: null,
    });
  });

  it("ticks only the restaurant it names", async () => {
    const id = await newRestaurant();
    const other = await newRestaurant();

    await admin.db.execute(tickSql(id, true));

    expect((await checklistOf(other))?.qr_codes_printed).toBe(false);
  });

  it("audits each change as the platform admin, in that restaurant's log", async () => {
    const id = await newRestaurant();

    await admin.db.execute(tickSql(id, true));
    await admin.db.execute(tickSql(id, false));

    const entries = (await auditOf(id)).filter(({ action }) =>
      action.startsWith("onboarding."),
    );
    expect(entries.map(({ action }) => action).sort()).toEqual([
      "onboarding.qr_codes_printed",
      "onboarding.qr_codes_unprinted",
    ]);
    expect(entries[0]).toMatchObject({
      actorType: "platform_admin",
      actorId: adminId,
      entityType: "restaurant",
      entityId: id,
    });
  });

  it("ticking again keeps the first tick's time and admin, and writes no second audit row", async () => {
    const id = await newRestaurant();
    const [second] = await owner.db
      .insert(platformAdmins)
      .values({ email: `second-${crypto.randomUUID()}@example.com` })
      .returning();
    const rowOf = async () =>
      (await owner.db.select().from(onboardingChecklist).where(eq(onboardingChecklist.restaurantId, id)))[0];
    try {
      await admin.db.execute(tickSql(id, true));
      const first = await rowOf();

      await admin.db.execute(tickSql(id, true, second.id));

      expect(await rowOf()).toEqual(first);
      expect(first.qrCodesPrintedBy).toBe(adminId);
      const printed = (await auditOf(id)).filter(
        ({ action }) => action === "onboarding.qr_codes_printed",
      );
      expect(printed).toHaveLength(1);
    } finally {
      await owner.db.delete(platformAdmins).where(eq(platformAdmins.id, second.id));
    }
  });

  it("unticking a restaurant that was never ticked writes no audit row", async () => {
    const id = await newRestaurant();

    await admin.db.execute(tickSql(id, false));

    expect(await checklistOf(id)).toMatchObject({ qr_codes_printed: false });
    expect(
      (await auditOf(id)).filter(({ action }) => action.startsWith("onboarding.")),
    ).toEqual([]);
  });

  it("revoking an admin who has ticked something still works", async () => {
    const id = await newRestaurant();
    const [leaving] = await owner.db
      .insert(platformAdmins)
      .values({ email: `leaving-${crypto.randomUUID()}@example.com` })
      .returning();
    await admin.db.execute(tickSql(id, true, leaving.id));

    await owner.db.delete(platformAdmins).where(eq(platformAdmins.id, leaving.id));

    expect(await owner.db.select().from(platformAdmins).where(eq(platformAdmins.id, leaving.id))).toEqual([]);
    expect(await checklistOf(id)).toMatchObject({ qr_codes_printed: true });
  });

  it("refuses a restaurant that doesn't exist", async () => {
    await failsWith(admin.db.execute(tickSql(crypto.randomUUID(), true)), NO_DATA_FOUND);
  });

  it("refuses an id that isn't a platform admin's, changing nothing", async () => {
    const id = await newRestaurant();
    await failsWith(
      admin.db.execute(tickSql(id, true, crypto.randomUUID())),
      INSUFFICIENT_PRIVILEGE,
    );
    expect((await checklistOf(id))?.qr_codes_printed).toBe(false);
  });

  it("can't be called as app_tenant, inside a tenant or out of one", async () => {
    const id = await newRestaurant();
    await failsWith(app.db.execute(tickSql(id, true)), INSUFFICIENT_PRIVILEGE);
    await failsWith(
      app.db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.restaurant_id', ${restaurantA}, true)`);
        return tx.execute(tickSql(id, true));
      }),
      INSUFFICIENT_PRIVILEGE,
    );
  });
});

