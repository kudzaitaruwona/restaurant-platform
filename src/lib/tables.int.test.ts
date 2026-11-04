import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auditLog, diningTables, restaurants } from "@/db/schema";
import {
  openOwnerDatabase,
  testDatabaseSettings,
} from "../../test/integration/database";
import { menuTag } from "./menu-cache";
import { addTable, getPrintHeader, listTables, regenerateQrToken } from "./tables";

const cache = vi.hoisted(() => ({ revalidateTag: vi.fn() }));
vi.mock("next/cache", () => cache);

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

describe("regenerateQrToken", () => {
  const ownerOf = (tenant: { restaurantId: string }) => ({
    ...tenant,
    staffId: crypto.randomUUID(),
  });

  async function oneTable(tenant: { restaurantId: string }, label = "7") {
    await addTable(tenant, { label, capacity: 4 });
    const [table] = (await owner.db
      .select()
      .from(diningTables)
      .where(eq(diningTables.restaurantId, tenant.restaurantId))).filter((t) => t.label === label);
    return table;
  }

  it("mints a new token, sets token_rotated_at, and keeps the rest of the table", async () => {
    const tenant = await newRestaurant();
    const before = await oneTable(tenant);
    expect(before.tokenRotatedAt).toBeNull();

    expect(await regenerateQrToken(ownerOf(tenant), before.id)).toBe("done");

    const [after] = await owner.db.select().from(diningTables).where(eq(diningTables.id, before.id));
    expect(after.qrToken).toMatch(/^[0-9A-Za-z]{22}$/);
    expect(after.qrToken).not.toBe(before.qrToken);
    expect(after.tokenRotatedAt).toBeInstanceOf(Date);
    expect(after).toMatchObject({ label: "7", capacity: 4, sortOrder: before.sortOrder });
  });

  it("writes an audit entry for an owner, naming the table and never the token", async () => {
    const tenant = await newRestaurant();
    const ctx = ownerOf(tenant);
    const before = await oneTable(tenant);

    await regenerateQrToken(ctx, before.id);

    const [after] = await owner.db.select().from(diningTables).where(eq(diningTables.id, before.id));
    const entries = await owner.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.restaurantId, tenant.restaurantId));
    expect(entries).toMatchObject([
      {
        action: "table.regenerate_qr",
        entityType: "table",
        entityId: before.id,
        actorType: "staff",
        actorId: ctx.staffId,
      },
    ]);
    const logged = JSON.stringify(entries);
    expect(logged).not.toContain(before.qrToken);
    expect(logged).not.toContain(after.qrToken);
  });

  it("audits a platform admin by platform_admins.id", async () => {
    const tenant = await newRestaurant();
    const platformAdminId = crypto.randomUUID();
    const table = await oneTable(tenant);

    await regenerateQrToken({ ...ownerOf(tenant), platformAdminId }, table.id);

    const [entry] = await owner.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.restaurantId, tenant.restaurantId));
    expect(entry).toMatchObject({ actorType: "platform_admin", actorId: platformAdminId });
  });

  it("expires the restaurant's cached menu once it has committed", async () => {
    const tenant = await newRestaurant();
    const table = await oneTable(tenant);
    cache.revalidateTag.mockClear();

    await regenerateQrToken(ownerOf(tenant), table.id);

    expect(cache.revalidateTag).toHaveBeenCalledWith(menuTag(tenant.restaurantId), { expire: 0 });
  });

  it("is not_found for another restaurant's table, an archived one or an unknown id, and changes nothing", async () => {
    const [mine, theirs] = [await newRestaurant(), await newRestaurant()];
    const other = await oneTable(theirs);
    const archived = await oneTable(mine, "old");
    await owner.db
      .update(diningTables)
      .set({ archivedAt: new Date() })
      .where(eq(diningTables.id, archived.id));
    cache.revalidateTag.mockClear();

    for (const id of [other.id, archived.id, crypto.randomUUID()]) {
      expect(await regenerateQrToken(ownerOf(mine), id)).toBe("not_found");
    }

    const rows = await owner.db
      .select()
      .from(diningTables)
      .where(inArray(diningTables.id, [other.id, archived.id]));
    expect(rows.map((row) => row.qrToken).sort()).toEqual([other.qrToken, archived.qrToken].sort());
    expect(rows.every((row) => row.tokenRotatedAt === null)).toBe(true);
    expect(await owner.db.select().from(auditLog).where(eq(auditLog.restaurantId, mine.restaurantId))).toEqual([]);
    expect(cache.revalidateTag).not.toHaveBeenCalled();
  });
});
