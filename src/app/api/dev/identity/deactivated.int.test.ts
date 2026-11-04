import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { staff } from "@/db/schema";
import { DEV_IDENTITY_COOKIE } from "@/lib/tenant/dev-identities";
import {
  openOwnerDatabase,
  testDatabaseSettings,
} from "../../../../../test/integration/database";

const jar = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      jar.has(name) ? { name, value: jar.get(name) } : undefined,
    set: (name: string, value: string) => jar.set(name, value),
  }),
}));

// An identity of its own to deactivate: the seeded rows stay as they are,
// because test files share the database.
const leaver = vi.hoisted(() => ({
  key: "a-leaver",
  label: "Leaver",
  restaurantId: "00000000-0000-4000-8000-00000000000a",
  staffId: crypto.randomUUID(),
  role: "staff",
}));

vi.mock("@/lib/tenant/dev-identities", async (original) => {
  const actual = await original<typeof import("@/lib/tenant/dev-identities")>();
  return {
    ...actual,
    findDevIdentity: (key: string) =>
      key === leaver.key ? leaver : actual.findDevIdentity(key),
  };
});

const owner = openOwnerDatabase();

function pick(identity: string) {
  const body = new FormData();
  body.set("identity", identity);
  return import("./route").then(({ POST }) =>
    POST(new Request("http://localhost:3000/api/dev/identity", { method: "POST", body })),
  );
}

describe("switching to a deactivated identity", () => {
  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
    vi.stubEnv("DEV_AUTH_BYPASS", "1");
    await owner.db.insert(staff).values({
      id: leaver.staffId,
      restaurantId: leaver.restaurantId,
      email: `${leaver.staffId}@example.test`,
      displayName: leaver.label,
    });
  });
  beforeEach(() => jar.clear());
  afterAll(async () => {
    await owner.db.delete(staff).where(eq(staff.id, leaver.staffId));
    await owner.pool.end();
    vi.unstubAllEnvs();
  });

  it("works while they're active, then is refused", async () => {
    expect((await pick(leaver.key)).status).toBe(303);
    jar.clear();

    await owner.db
      .update(staff)
      .set({ active: false })
      .where(eq(staff.id, leaver.staffId));

    expect((await pick(leaver.key)).status).toBe(403);
    expect(jar.has(DEV_IDENTITY_COOKIE)).toBe(false);
  });
});
