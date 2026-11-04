import { eq, sql } from "drizzle-orm";
import type { Database } from "../../src/db/client";
import {
  bookings,
  bookingSettings,
  diningTables,
  restaurants,
  servicePeriods,
} from "../../src/db/schema";

const token = () => crypto.randomUUID().replaceAll("-", "").slice(0, 22);

type TableSpec = {
  label?: string;
  capacity: number;
  bookable?: boolean;
  sortOrder?: number;
};

/**
 * A restaurant taking online bookings, of its own, because the constraint and the
 * availability it drives are per table. Dinner every day, 18:00 to 21:00, every 30
 * minutes, unless a test says otherwise. Written as the role that owns the tables.
 * The rows stay behind under a random slug, like every fixture restaurant here.
 */
export async function bookableRestaurant(
  owner: Database,
  {
    tables = [{ capacity: 2 }],
    rules = {},
    timezone = "Africa/Harare",
  }: {
    tables?: TableSpec[];
    rules?: Partial<typeof bookingSettings.$inferInsert>;
    timezone?: string;
  } = {},
) {
  const restaurantId = crypto.randomUUID();
  const slug = `bookings-${restaurantId}`;
  await owner.insert(restaurants).values({
    id: restaurantId,
    name: `Restaurant ${restaurantId}`,
    slug,
    menuToken: restaurantId,
    currencyMode: "usd_only",
    contactPhone: "+263771234567",
    timezone,
  });
  const rows = tables.map(({ label, ...table }, index) => ({
    id: crypto.randomUUID(),
    restaurantId,
    label: label ?? `T${index + 1}`,
    qrToken: token(),
    ...table,
  }));
  const tableIds = rows.map(({ id }) => id);
  if (rows.length > 0) await owner.insert(diningTables).values(rows);
  await owner.insert(servicePeriods).values(
    [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      restaurantId,
      name: "Dinner",
      weekday,
      opensAt: "18:00",
      lastBookingAt: "21:00",
      closesAt: "23:00",
    })),
  );
  await owner
    .update(bookingSettings)
    .set({ enabled: true, slotIntervalMinutes: 30, ...rules })
    .where(eq(bookingSettings.restaurantId, restaurantId));
  return { restaurantId, slug, tableIds };
}

/** A booking row with nothing interesting about it, for a test to adjust. */
export const aBooking = (
  restaurantId: string,
  tableId: string,
  startsAt: string,
  holdEndsAt: string,
) => ({
  restaurantId,
  tableId,
  guestName: "Fixture guest",
  whatsappOptIn: true,
  partySize: 2,
  startsAt: new Date(startsAt),
  endsAt: new Date(holdEndsAt),
  holdEndsAt: new Date(holdEndsAt),
  status: "confirmed" as const,
  source: "online" as const,
  manageToken: token(),
});

/** Runs a statement as the app does: app_tenant, inside the tenant. */
export const asTenant = <T>(
  app: Database,
  restaurantId: string,
  run: (tx: Parameters<Parameters<Database["transaction"]>[0]>[0]) => Promise<T>,
) =>
  app.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.restaurant_id', ${restaurantId}, true)`);
    return run(tx);
  });

export const bookingsOf = (owner: Database, restaurantId: string) =>
  owner.select().from(bookings).where(eq(bookings.restaurantId, restaurantId));
