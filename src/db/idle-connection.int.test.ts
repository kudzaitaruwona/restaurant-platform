import { inspect } from "node:util";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  openOwnerDatabase,
  openTestDatabase,
  testDatabaseSettings,
} from "../../test/integration/database";

const owner = openOwnerDatabase();
afterAll(() => owner.pool.end());
afterEach(() => vi.restoreAllMocks());

describe("a pooled connection that drops while idle", () => {
  it("is logged without the connection string, and doesn't crash the process", async () => {
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = openTestDatabase();
    try {
      const { rows } = await app.db.execute(
        sql`select pg_backend_pid() as pid`,
      );
      await owner.db.execute(sql`select pg_terminate_backend(${rows[0].pid}::int)`);

      await vi.waitFor(() => expect(report).toHaveBeenCalled());
      // inspect, not String: the driver's error object holds the client, and
      // the client holds the password.
      const logged = inspect(report.mock.calls, { depth: null });
      expect(logged).toMatch(/idle database connection.*57P01/i);
      const { password } = new URL(testDatabaseSettings().connectionString);
      expect(logged).not.toContain(password);
    } finally {
      await app.pool.end();
    }
  });
});
