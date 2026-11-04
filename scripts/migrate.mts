/**
 * `npm run db:migrate`: applies pending migrations from db/migrations to
 * DATABASE_URL_UNPOOLED (the direct, non-pooled connection, as the role that
 * owns the tables), through the same Neon WebSocket driver the app uses. Then
 * lets the app and admin roles log in with the passwords in DATABASE_URL and
 * DATABASE_URL_ADMIN.
 */
import nextEnv from "@next/env";
import { provisionAppRole } from "../src/db/app-role";
import { runMigrations } from "../src/db/migrate";
import { ADMIN_DATABASE_ROLE } from "../src/lib/env";

nextEnv.loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");

const connectionString = process.env.DATABASE_URL_UNPOOLED;
const appConnectionString = process.env.DATABASE_URL;
const adminConnectionString = process.env.DATABASE_URL_ADMIN;
if (!connectionString || !appConnectionString || !adminConnectionString) {
  console.error(
    "DATABASE_URL_UNPOOLED (direct URL, owner role), DATABASE_URL (the app role) and DATABASE_URL_ADMIN (the admin role) are all needed. See .env.example.",
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
await provisionAppRole(settings, adminConnectionString, ADMIN_DATABASE_ROLE);
console.log("Migrations applied.");
