import { createDatabase } from "../../src/db/client";

/**
 * Connection settings for the integration tests: a real Postgres reached the
 * same way the app reaches it, through Neon's WebSocket Pool driver.
 */
function settingsFor(variable: string) {
  const connectionString = process.env[variable];
  if (!connectionString) {
    throw new Error(
      `${variable} is missing. Integration tests need a real Postgres: run \`npm run db:up\` and see .env.example.`,
    );
  }
  return { connectionString, wsProxy: process.env.NEON_WS_PROXY || undefined };
}

/** The role that owns the tables. Migrations and fixtures only: RLS skips it. */
export function ownerDatabaseSettings() {
  return settingsFor("TEST_DATABASE_URL");
}

/** The app's role, app_tenant. This is the one RLS applies to. */
export function testDatabaseSettings() {
  return settingsFor("TEST_DATABASE_URL_APP");
}

/** The admin path's role, app_admin: the only one the platform_* functions take. */
export function adminDatabaseSettings() {
  return settingsFor("TEST_DATABASE_URL_ADMIN");
}

export function openOwnerDatabase() {
  return createDatabase(ownerDatabaseSettings());
}

export function openTestDatabase() {
  return createDatabase(testDatabaseSettings());
}

export function openAdminDatabase() {
  return createDatabase(adminDatabaseSettings());
}
