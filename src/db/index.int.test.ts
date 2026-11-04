import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  adminDatabaseSettings,
  testDatabaseSettings,
} from "../../test/integration/database";

describe("@/db (the app's database)", () => {
  afterAll(() => vi.unstubAllEnvs());

  it("connects to DATABASE_URL from the validated environment", async () => {
    vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
    vi.resetModules();
    const { getDb } = await import("@/db");

    const { rows } = await getDb().execute(sql`select current_database() as name`);

    expect(rows[0].name).toBe(
      new URL(testDatabaseSettings().connectionString).pathname.slice(1),
    );
  });
});

describe("@/db/admin (the admin path's database)", () => {
  afterAll(() => vi.unstubAllEnvs());

  it("connects as app_admin, from DATABASE_URL_ADMIN", async () => {
    vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
    vi.stubEnv("DATABASE_URL_ADMIN", adminDatabaseSettings().connectionString);
    vi.resetModules();
    const { getAdminDb } = await import("@/db/admin");

    const { rows } = await getAdminDb().execute(sql`select current_user as name`);

    expect(rows[0].name).toBe("app_admin");
  });

  it("says what's missing rather than falling back to the app's role", async () => {
    vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
    vi.stubEnv("DATABASE_URL_ADMIN", "");
    vi.resetModules();
    const { getAdminDb } = await import("@/db/admin");

    expect(() => getAdminDb()).toThrow(/DATABASE_URL_ADMIN is missing/);
  });
});
