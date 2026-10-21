import { createDatabase } from "../../src/db/client";

/**
 * Connection settings for the integration tests: a real Postgres reached the
 * same way the app reaches it, through Neon's WebSocket Pool driver.
 */
export function testDatabaseSettings() {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "TEST_DATABASE_URL is missing. Integration tests need a real Postgres: run `npm run db:up` and see .env.example.",
    );
  }
  return { connectionString, wsProxy: process.env.NEON_WS_PROXY || undefined };
}

export function openTestDatabase() {
  return createDatabase(testDatabaseSettings());
}
