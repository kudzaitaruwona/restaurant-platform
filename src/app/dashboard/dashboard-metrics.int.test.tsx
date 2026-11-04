import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bookings, staff } from "@/db/schema";
import type { TenantContext } from "@/lib/tenant";
import { aBooking, bookableRestaurant } from "../../../test/integration/bookings";
import { openOwnerDatabase, testDatabaseSettings } from "../../../test/integration/database";
import { Dashboard } from "./dashboard";

/**
 * The owner's booking metrics on the dashboard (spec 04 › Success metrics), on
 * restaurants of their own. Who's asking is faked, as in owner-screens: the real
 * seam is covered by access.int.test.ts.
 */
const session = vi.hoisted(() => ({ tenant: undefined as unknown }));

vi.mock("@/lib/tenant", async (original) => ({
  ...(await original<typeof import("@/lib/tenant")>()),
  getTenantContext: async () => session.tenant as TenantContext,
}));

const owner = openOwnerDatabase();
beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});
afterAll(async () => {
  await owner.pool.end();
  vi.unstubAllEnvs();
});

const render = async () => renderToStaticMarkup(await Dashboard());

async function restaurantWith(online: number, noShows: number) {
  const { restaurantId, tableIds } = await bookableRestaurant(owner.db, {
    tables: Array.from({ length: online }, () => ({ capacity: 2 })),
  });
  const staffId = crypto.randomUUID();
  await owner.db.insert(staff).values([
    { id: staffId, restaurantId, email: `${staffId}@example.test`, displayName: "Owner", role: "owner" },
  ]);
  await owner.db.insert(bookings).values(
    tableIds.map((tableId, index) => ({
      ...aBooking(restaurantId, tableId, "2027-01-10T16:00:00Z", "2027-01-10T17:45:00Z"),
      // 03:00 UTC is 05:00 in Harare, before dinner opens at 18:00.
      createdAt: new Date("2026-11-05T03:00:00Z"),
      status: index < noShows ? ("no_show" as const) : ("completed" as const),
    })),
  );
  return { restaurantId, staffId };
}

describe("the dashboard's booking metrics", () => {
  it("shows an owner their restaurant's numbers", async () => {
    const { restaurantId, staffId } = await restaurantWith(4, 1);
    session.tenant = { restaurantId, staffId, role: "owner" };

    const html = await render();

    expect(html).toContain("Booked online");
    expect(html).toContain("4 online, 0 added by staff");
    expect(html).toContain("No-show rate");
    expect(html).toContain("25%");
    expect(html).toContain("1 of 4 finished bookings");
  });

  it("never includes another restaurant's bookings", async () => {
    const mine = await restaurantWith(1, 0);
    await restaurantWith(5, 5);
    session.tenant = { ...mine, role: "owner" };

    const html = await render();

    expect(html).toContain("1 online, 0 added by staff");
    expect(html).toContain("0 of 1 finished bookings");
    expect(html).not.toContain("5 online");
  });

  it("doesn't show staff the owner's numbers", async () => {
    const { restaurantId, staffId } = await restaurantWith(2, 1);
    session.tenant = { restaurantId, staffId, role: "staff" };

    const html = await render();

    expect(html).not.toContain("No-show rate");
    expect(html).not.toContain("Booked online");
  });

  it("shows a platform admin inside the restaurant the same numbers", async () => {
    const { restaurantId, staffId } = await restaurantWith(2, 1);
    session.tenant = { restaurantId, staffId, role: "owner", platformAdminId: crypto.randomUUID() };

    expect(await render()).toContain("1 of 2 finished bookings");
  });
});
