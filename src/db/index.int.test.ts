import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { testDatabaseSettings } from "../../test/integration/database";

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
