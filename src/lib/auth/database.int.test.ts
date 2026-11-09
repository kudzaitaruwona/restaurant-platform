import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  adminDatabaseSettings,
  staffAuthDatabaseSettings,
  testDatabaseSettings,
} from "../../../test/integration/database";

describe("authDatabase (sign-in's database, per audience)", () => {
  afterAll(() => vi.unstubAllEnvs());

  it.each([
    ["staff", "app_staff_auth"],
    ["admin", "app_admin"],
  ] as const)("the %s audience connects as %s", async (audience, role) => {
    vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
    vi.stubEnv("DATABASE_URL_ADMIN", adminDatabaseSettings().connectionString);
    vi.stubEnv("DATABASE_URL_STAFF_AUTH", staffAuthDatabaseSettings().connectionString);
    vi.resetModules();
    const { authDatabase } = await import("./database");

    const { rows } = await authDatabase(audience).execute(sql`select current_user as name`);

    expect(rows[0].name).toBe(role);
  });
});
