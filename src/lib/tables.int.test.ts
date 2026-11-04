import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auditLog, diningTables, restaurants } from "@/db/schema";
import {
  openOwnerDatabase,
  testDatabaseSettings,
} from "../../test/integration/database";
import { addTable, getPrintHeader, listTables } from "./tables";

/** Runs as app_tenant, so everything here also holds under RLS. */
const owner = openOwnerDatabase();
const created: string[] = [];

async function newRestaurant(extra: Partial<typeof restaurants.$inferInsert> = {}) {
  const restaurantId = crypto.randomUUID();
  await owner.db.insert(restaurants).values({
    id: restaurantId,
    name: "Mama's Kitchen",
    slug: `tables-${restaurantId}`,
    menuToken: `tables-${restaurantId}`,
    currencyMode: "usd_only",
    ...extra,
  });
  created.push(restaurantId);
  return { restaurantId };
}

const tokenOf = async (restaurantId: string) =>
  (await owner.db.select().from(diningTables).where(eq(diningTables.restaurantId, restaurantId)))
    .map((row) => row.qrToken);

beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});

afterAll(async () => {
  await owner.db.delete(auditLog).where(inArray(auditLog.restaurantId, created));
  await owner.db.delete(diningTables).where(inArray(diningTables.restaurantId, created));
  await owner.db.delete(restaurants).where(inArray(restaurants.id, created));
  await owner.pool.end();
  vi.unstubAllEnvs();
});

describe("addTable", () => {
  it("adds a table with a label, a capacity and a token of its own, in one step", async () => {
    const tenant = await newRestaurant();

    expect(await addTable(tenant, { label: "7", capacity: 4 })).toBe("saved");

    const [table] = await listTables(tenant);
    expect(table).toMatchObject({ label: "7", capacity: 4, bookable: true });
    expect(table.qrToken).toMatch(/^[0-9A-Za-z]{22}$/);
  });

  it("gives every table a different token", async () => {
    const tenant = await newRestaurant();
    for (const label of ["1", "2", "3"]) await addTable(tenant, { label, capacity: 2 });

    expect(new Set(await tokenOf(tenant.restaurantId)).size).toBe(3);
  });

  it("lists tables in the order they were added", async () => {
    const tenant = await newRestaurant();
    for (const label of ["B2", "A1", "Patio"]) await addTable(tenant, { label, capacity: 2 });

    expect((await listTables(tenant)).map(({ label }) => label)).toEqual(["B2", "A1", "Patio"]);
  });

  it("refuses a label a live table already has, and adds nothing", async () => {
    const tenant = await newRestaurant();
    await addTable(tenant, { label: "7", capacity: 4 });

    expect(await addTable(tenant, { label: "7", capacity: 6 })).toBe("label_taken");

    expect(await listTables(tenant)).toHaveLength(1);
  });

  it("lets two restaurants both have a table 7", async () => {
    const [one, two] = [await newRestaurant(), await newRestaurant()];

    expect(await addTable(one, { label: "7", capacity: 4 })).toBe("saved");
    expect(await addTable(two, { label: "7", capacity: 4 })).toBe("saved");
  });

  it("lets only one of two adds of the same label through, when they race", async () => {
    const tenant = await newRestaurant();

    const results = await Promise.all([
      addTable(tenant, { label: "7", capacity: 4 }),
      addTable(tenant, { label: "7", capacity: 4 }),
    ]);

    expect(results.sort()).toEqual(["label_taken", "saved"]);
  });

  it("lists only the restaurant's own tables", async () => {
    const [mine, theirs] = [await newRestaurant(), await newRestaurant()];
    await addTable(theirs, { label: "Theirs", capacity: 4 });

    expect(await listTables(mine)).toEqual([]);
  });

  it("audits a platform admin's add, and an owner's isn't on the list", async () => {
    const tenant = await newRestaurant();
    const platformAdminId = crypto.randomUUID();

    await addTable({ ...tenant, platformAdminId }, { label: "A", capacity: 2 });
    await addTable(tenant, { label: "B", capacity: 2 });

    const entries = await owner.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.restaurantId, tenant.restaurantId));
    expect(entries).toMatchObject([
      { action: "table.create", entityType: "table", actorType: "platform_admin", actorId: platformAdminId },
    ]);
  });
});

describe("getPrintHeader", () => {
  it("names the restaurant and its Wi-Fi", async () => {
    const tenant = await newRestaurant({ wifiName: "Guest", wifiPassword: "sadza" });

    expect(await getPrintHeader(tenant)).toEqual({
      name: "Mama's Kitchen",
      wifiName: "Guest",
      wifiPassword: "sadza",
    });
  });
});
