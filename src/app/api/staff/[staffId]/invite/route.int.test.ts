import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { restaurants, staff } from "@/db/schema";
import { FORM_FETCH_HEADER } from "@/lib/form-response";
import {
  openOwnerDatabase,
  testDatabaseSettings,
} from "../../../../../../test/integration/database";
import { installFakeServices } from "../../../../../../test/integration/fake-services";
import { statusOf } from "../../../../../../test/integration/http";

/**
 * "Send invite again" from /dashboard/staff (S-42), as the owner in the context.
 * The rules are in src/lib/staff-management.int.test.ts; this is what the route
 * answers for each, which ActionForm shows under the person.
 */
const context = vi.hoisted(() => ({
  tenant: undefined as undefined | { restaurantId: string; staffId: string; role: string },
}));

vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  getTenantContext: async () => context.tenant,
}));

const owner = openOwnerDatabase();
let services: ReturnType<typeof installFakeServices>;

beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
  services = installFakeServices();
});
beforeEach(() => {
  services.sent.length = 0;
  services.refusing.clear();
});
afterAll(async () => {
  await owner.pool.end();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** A restaurant of its own with an owner in the context and one colleague. */
async function setUp() {
  const restaurantId = crypto.randomUUID();
  const ownerId = crypto.randomUUID();
  const colleagueId = crypto.randomUUID();
  await owner.db.insert(restaurants).values({
    id: restaurantId,
    name: "Fixture",
    slug: `invite-route-${restaurantId}`,
    menuToken: restaurantId,
    currencyMode: "usd_only",
  });
  await owner.db.insert(staff).values([
    { id: ownerId, restaurantId, email: `${ownerId}@example.test`, displayName: "Owner", role: "owner" },
    { id: colleagueId, restaurantId, email: `${colleagueId}@example.test`, displayName: "Colleague" },
  ]);
  context.tenant = { restaurantId, staffId: ownerId, role: "owner" };
  return { colleagueId, email: `${colleagueId}@example.test` };
}

async function invite(staffId: string) {
  const { POST } = await import("./route");
  return POST(
    new NextRequest(new URL(`/api/staff/${staffId}/invite`, "http://localhost:3000"), {
      method: "POST",
      headers: { [FORM_FETCH_HEADER]: "1" },
    }),
    { params: Promise.resolve({ staffId }) },
  );
}

describe("POST /api/staff/[staffId]/invite", () => {
  it("sends it and answers as a saved form", async () => {
    const { colleagueId, email } = await setUp();

    expect((await invite(colleagueId)).status).toBe(204);
    await services.emailTo(email);
  });

  it("is a 502 that says the email didn't go", async () => {
    const { colleagueId, email } = await setUp();
    services.refusing.add(email);

    const response = await invite(colleagueId);

    expect(response.status).toBe(502);
    expect((await response.json()).error).toBe(
      "The invite email didn't go. Try again in a few minutes.",
    );
  });

  it("is a 429 once they've had 3 in the last hour", async () => {
    const { colleagueId } = await setUp();
    for (let i = 0; i < 3; i++) await invite(colleagueId);

    const response = await invite(colleagueId);

    expect(response.status).toBe(429);
    expect((await response.json()).error).toBe(
      "They've been sent 3 invites in the last hour. Try again later.",
    );
  });

  it("is a 409 for someone who has signed in", async () => {
    const { colleagueId } = await setUp();
    await owner.db.update(staff).set({ firstSignedInAt: new Date() }).where(eq(staff.id, colleagueId));

    const response = await invite(colleagueId);

    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("They've already signed in.");
  });

  it.each(["not-a-uuid", crypto.randomUUID()])("is a 404 for %s", async (staffId) => {
    await setUp();
    expect(await statusOf(() => invite(staffId))).toBe(404);
  });

  it("is a 403 for a staff context (S-26)", async () => {
    const { colleagueId } = await setUp();
    context.tenant = { ...context.tenant!, role: "staff" };
    expect(await statusOf(() => invite(colleagueId))).toBe(403);
    expect(services.sent).toEqual([]);
  });
});
