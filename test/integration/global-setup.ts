// Relative imports: global setup runs outside the test projects' resolver.
import { runMigrations } from "../../src/db/migrate";
import { testDatabaseSettings } from "./database";

// Brings the test database up to the latest migration once per run.
export default async function setup() {
  try {
    await runMigrations(testDatabaseSettings());
  } catch (error) {
    // Vitest can fail to print errors thrown from global setup, so say it here.
    const cause = error instanceof Error && error.cause ? `\nCause: ${String(error.cause)}` : "";
    console.error(
      `\nIntegration setup failed: ${String(error)}${cause}\n` +
        "Is Postgres and its wsproxy running (`npm run db:up`), and NEON_WS_PROXY set?\n",
    );
    throw error;
  }
}
