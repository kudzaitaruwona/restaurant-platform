/**
 * `npm run db:migrate`: applies pending migrations from db/migrations to
 * DATABASE_URL_UNPOOLED (the direct, non-pooled connection, as the role that
 * owns the tables), through the same Neon WebSocket driver the app uses. Then
 * lets the app role log in with the password in DATABASE_URL.
 */
import nextEnv from "@next/env";
import { provisionAppRole } from "../src/db/app-role";
import { runMigrations } from "../src/db/migrate";

nextEnv.loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");

const connectionString = process.env.DATABASE_URL_UNPOOLED;
const appConnectionString = process.env.DATABASE_URL;
if (!connectionString || !appConnectionString) {
  console.error(
    "DATABASE_URL_UNPOOLED (direct URL, owner role) and DATABASE_URL (the app role) are both needed. See .env.example.",
  );
  process.exit(1);
}

const target = new URL(connectionString);
console.log(`Migrating ${target.host}${target.pathname} ...`);
const settings = {
  connectionString,
  wsProxy: process.env.NEON_WS_PROXY || undefined,
};
await runMigrations(settings);
await provisionAppRole(settings, appConnectionString);
console.log("Migrations applied.");
