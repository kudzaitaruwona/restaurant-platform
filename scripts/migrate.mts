/**
 * `npm run db:migrate`: applies pending migrations from db/migrations to
 * DATABASE_URL_UNPOOLED (the direct, non-pooled connection), through the same
 * Neon WebSocket driver the app uses.
 */
import nextEnv from "@next/env";
import { runMigrations } from "../src/db/migrate";

nextEnv.loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");

const connectionString = process.env.DATABASE_URL_UNPOOLED;
if (!connectionString) {
  console.error(
    "DATABASE_URL_UNPOOLED is missing: set it to the direct (non-pooled) database URL. See .env.example.",
  );
  process.exit(1);
}

const target = new URL(connectionString);
console.log(`Migrating ${target.host}${target.pathname} ...`);
await runMigrations({
  connectionString,
  wsProxy: process.env.NEON_WS_PROXY || undefined,
});
console.log("Migrations applied.");
