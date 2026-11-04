// Relative imports: global setup runs outside the test projects' resolver.
import { provisionAppRole } from "../../src/db/app-role";
import { runMigrations } from "../../src/db/migrate";
import { seedDevData } from "../../src/db/seed";
import {
  openOwnerDatabase,
  ownerDatabaseSettings,
  testDatabaseSettings,
} from "./database";

// Once per run: brings the test database up to the latest migration, lets the
// app role log in, and seeds restaurants A and B. Tests must not change the
// seeded rows, because test files run in parallel against this database.
export default async function setup() {
  try {
    const owner = ownerDatabaseSettings();
    await runMigrations(owner);
    await provisionAppRole(owner, testDatabaseSettings().connectionString);

    const { db, pool } = openOwnerDatabase();
    await seedDevData(db);
    await pool.end();
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
