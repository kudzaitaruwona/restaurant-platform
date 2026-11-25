import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { restaurants, staff } from "@/db/schema";
import { FORM_FETCH_HEADER } from "@/lib/form-response";
import {
  openOwnerDatabase,
  testDatabaseSettings,
} from "../../../../../test/integration/database";

/** Renaming from /dashboard (#93): a plain post redirects, ActionForm's fetch gets a 204 or the refusal. */
const context = vi.hoisted(() => ({
  tenant: undefined as undefined | { restaurantId: string; staffId: string; role: string },
}));

vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  getTenantContext: async () => context.tenant,
}));

const owner = openOwnerDatabase();

beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});
afterAll(async () => {
  await owner.pool.end();
  vi.unstubAllEnvs();
});

async function setUp() {
  const restaurantId = crypto.randomUUID();
  const ownerId = crypto.randomUUID();
  const colleagueId = crypto.randomUUID();
  await owner.db.insert(restaurants).values({
    id: restaurantId,
    name: "Fixture",
    slug: `rename-route-${restaurantId}`,
    menuToken: restaurantId,
    currencyMode: "usd_only",
  });
  await owner.db.insert(staff).values([
    { id: ownerId, restaurantId, email: `${ownerId}@example.test`, displayName: "Owner", role: "owner" },
    { id: colleagueId, restaurantId, email: `${colleagueId}@example.test`, displayName: "Colleague" },
  ]);
  context.tenant = { restaurantId, staffId: ownerId, role: "owner" };
  return colleagueId;
}

async function rename(staffId: string, displayName: string, fetched: boolean) {
  const { POST } = await import("./route");
  const body = new FormData();
  body.set("displayName", displayName);
  return POST(
    new NextRequest(new URL(`/api/staff/${staffId}`, "http://localhost:3000"), {
      method: "POST",
      headers: fetched ? { [FORM_FETCH_HEADER]: "1" } : {},
      body,
    }),
    { params: Promise.resolve({ staffId }) },
  );
}

const nameOf = async (id: string) =>
  (await owner.db.select({ n: staff.displayName }).from(staff).where(eq(staff.id, id)))[0]?.n;

describe("POST /api/staff/[staffId]", () => {
  it("answers ActionForm's post with a 204 and renames", async () => {
    const id = await setUp();
    expect((await rename(id, "  Tendai  ", true)).status).toBe(204);
    expect(await nameOf(id)).toBe("Tendai");
  });

  it("still redirects a plain post back to /dashboard", async () => {
    const id = await setUp();
    const response = await rename(id, "Rudo", false);
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/dashboard");
  });

  it("refuses a blank name with a message ActionForm shows, and changes nothing", async () => {
    const id = await setUp();
    const response = await rename(id, "   ", true);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Enter a name, up to 200 characters.");
    expect(await nameOf(id)).toBe("Colleague");
  });
});
