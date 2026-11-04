import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testDatabaseSettings } from "../../../test/integration/database";
import { statusOf } from "../../../test/integration/http";
import { devIdentities, devPlatformAdmin } from "./dev-identities";

const session = vi.hoisted(() => ({ identity: undefined as string | undefined }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      session.identity === undefined
        ? undefined
        : { name, value: session.identity },
  }),
  headers: async () => new Headers(),
}));

const guard = async () =>
  (await import("./platform-admin")).getPlatformAdminContext();
const tenantContext = async () =>
  (await import("./index")).getTenantContext();

beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
  vi.stubEnv("DEV_AUTH_BYPASS", "1");
});
afterAll(() => vi.unstubAllEnvs());

describe("getPlatformAdminContext", () => {
  it("returns the platform admin, and nothing tenant-shaped", async () => {
    session.identity = devPlatformAdmin.key;
    expect(await guard()).toEqual({
      platformAdminId: devPlatformAdmin.platformAdminId,
      sessionId: devPlatformAdmin.sessionId,
    });
  });

  it.each(devIdentities.map((identity) => [identity.key] as const))(
    "is a 403 for restaurant staff: %s",
    async (key) => {
      session.identity = key;
      expect(await statusOf(guard)).toBe(403);
    },
  );

  it("is a 403 for the default identity, which is restaurant staff", async () => {
    session.identity = undefined;
    expect(await statusOf(guard)).toBe(403);
  });

  it("is a 401 with no identity", async () => {
    session.identity = "nobody";
    expect(await statusOf(guard)).toBe(401);
  });
});

describe("without the bypass", () => {
  it.each([
    ["DEV_AUTH_BYPASS is unset", "DEV_AUTH_BYPASS", ""],
    ["in production, even with the variable set", "NODE_ENV", "production"],
  ])("the dev admin cookie is nobody: %s", async (_name, variable, value) => {
    vi.stubEnv(variable, value);
    vi.resetModules(); // fresh env cache
    session.identity = devPlatformAdmin.key;

    expect(await statusOf(guard)).toBe(401);
    expect(await statusOf(tenantContext)).toBe(401);

    vi.unstubAllEnvs();
    vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
    vi.stubEnv("DEV_AUTH_BYPASS", "1");
  });
});
