import { eq, inArray } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { auditLog, exchangeRates, restaurants, staff } from "@/db/schema";
import type { TenantContext } from "@/lib/tenant/scope";
import {
  openOwnerDatabase,
  testDatabaseSettings,
} from "../../test/integration/database";
import { getCurrentRate, setExchangeRate } from "./exchange-rate";
import { getMenu } from "./menu";
import { menuTag } from "./menu-cache";

const revalidateTag = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidateTag }));

/** Runs as app_tenant, so everything here also holds under RLS. */
const owner = openOwnerDatabase();
const created: string[] = [];

async function newRestaurant(): Promise<TenantContext> {
  const restaurantId = crypto.randomUUID();
  const staffId = crypto.randomUUID();
  await owner.db.insert(restaurants).values({
    id: restaurantId,
    name: "Mama's Kitchen",
    slug: `rate-${restaurantId}`,
    menuToken: `rate-${restaurantId}`,
    currencyMode: "both",
  });
  await owner.db.insert(staff).values({
    id: staffId,
    restaurantId,
    email: `${staffId}@example.test`,
    displayName: "Owner",
    role: "owner",
  });
  created.push(restaurantId);
  return { restaurantId, staffId, role: "owner" };
}

const history = (restaurantId: string) =>
  owner.db
    .select()
    .from(exchangeRates)
    .where(eq(exchangeRates.restaurantId, restaurantId));

beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});

beforeEach(() => revalidateTag.mockClear());

afterAll(async () => {
  await owner.db.delete(auditLog).where(inArray(auditLog.restaurantId, created));
  await owner.db.delete(exchangeRates).where(inArray(exchangeRates.restaurantId, created));
  // The restaurants stay behind: one with an owner can't lose it (S-26).
  await owner.pool.end();
  vi.unstubAllEnvs();
});

describe("the current rate", () => {
  it("is none before one is set", async () => {
    const tenant = await newRestaurant();
    expect(await getCurrentRate(tenant)).toBeNull();
    expect((await getMenu(tenant)).pricing.rate).toBeNull();
  });

  it("is the latest of the rates set", async () => {
    const tenant = await newRestaurant();

    await setExchangeRate(tenant, { usdToZig: "26.2" });
    await setExchangeRate(tenant, { usdToZig: "27" });

    expect(await getCurrentRate(tenant)).toMatchObject({ usdToZig: "27" });
    expect((await getMenu(tenant)).pricing.rate).toBe("27");
  });

  it("is each restaurant's own", async () => {
    const [mine, theirs] = [await newRestaurant(), await newRestaurant()];
    await setExchangeRate(theirs, { usdToZig: "99" });

    expect(await getCurrentRate(mine)).toBeNull();
  });
});

describe("setting the rate", () => {
  it("adds a row each time and changes none, so there's a history", async () => {
    const tenant = await newRestaurant();

    await setExchangeRate(tenant, { usdToZig: "26.2" });
    await setExchangeRate(tenant, { usdToZig: "27" });

    const rows = await history(tenant.restaurantId);
    expect(rows.map((row) => row.usdToZig).sort()).toEqual(["26.2", "27"]);
    expect(rows.every((row) => row.setBy === tenant.staffId)).toBe(true);
  });

  it("audits each change for an owner too", async () => {
    const tenant = await newRestaurant();

    await setExchangeRate(tenant, { usdToZig: "26.2" });

    const [row] = await history(tenant.restaurantId);
    expect(
      await owner.db.select().from(auditLog).where(eq(auditLog.restaurantId, tenant.restaurantId)),
    ).toMatchObject([
      {
        actorType: "staff",
        actorId: tenant.staffId,
        action: "exchange_rate.set",
        entityType: "exchange_rate",
        entityId: row.id,
        details: { usdToZig: "26.2" },
      },
    ]);
  });

  it("audits a platform admin's change as theirs, not the shadow row's (S-29)", async () => {
    const tenant = await newRestaurant();
    const platformAdminId = crypto.randomUUID();

    await setExchangeRate({ ...tenant, platformAdminId }, { usdToZig: "26.2" });

    expect(
      await owner.db.select().from(auditLog).where(eq(auditLog.restaurantId, tenant.restaurantId)),
    ).toMatchObject([{ actorType: "platform_admin", actorId: platformAdminId }]);
  });

  it("saves nothing it can't audit", async () => {
    const tenant = await newRestaurant();

    await expect(
      setExchangeRate({ ...tenant, platformAdminId: "not-a-uuid" }, { usdToZig: "26.2" }),
    ).rejects.toThrow();

    expect(await history(tenant.restaurantId)).toEqual([]);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("refuses a rate the database won't take, and leaves the old one", async () => {
    const tenant = await newRestaurant();
    await setExchangeRate(tenant, { usdToZig: "26.2" });
    revalidateTag.mockClear();

    await expect(setExchangeRate(tenant, { usdToZig: "0" })).rejects.toThrow();

    expect(await getCurrentRate(tenant)).toMatchObject({ usdToZig: "26.2" });
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("revalidates this restaurant's public page, and no other", async () => {
    const tenant = await newRestaurant();

    await setExchangeRate(tenant, { usdToZig: "26.2" });

    expect(revalidateTag.mock.calls).toEqual([
      [menuTag(tenant.restaurantId), { expire: 0 }],
    ]);
  });
});
