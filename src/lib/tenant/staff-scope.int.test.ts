import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openOwnerDatabase } from "../../../test/integration/database";
import { statusOf } from "../../../test/integration/http";

// getTenantContext's staff lookup must name the restaurant itself, not lean on
// RLS. So run it as the owner, whom RLS skips: the query is all that's left.
const database = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock("@/db", () => ({ getDb: () => database.current }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

vi.mock("./dev-identities", async (original) => {
  const actual = await original<typeof import("./dev-identities")>();
  const [a, , b] = actual.devIdentities;
  return {
    ...actual,
    // Restaurant A's ID on restaurant B's staff member.
    defaultDevIdentity: { ...a, staffId: b.staffId },
  };
});

const owner = openOwnerDatabase();
database.current = owner.db;
afterAll(() => owner.pool.end());

beforeEach(() => {
  vi.stubEnv("DEV_AUTH_BYPASS", "1");
  vi.stubEnv("NODE_ENV", "test");
});

describe("getTenantContext's staff lookup", () => {
  it("finds no one for a staff ID from another restaurant, even with RLS out of the way", async () => {
    const { getTenantContext } = await import("@/lib/tenant");
    expect(await statusOf(getTenantContext)).toBe(401);
  });
});
