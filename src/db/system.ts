import "server-only";
import { getEnv } from "@/lib/env";
import { createDatabase, type Database } from "./client";

let database: Database | undefined;

/**
 * The scheduled job's database: its own login and its own pool, on
 * DATABASE_URL_SYSTEM (spec 01, S-28, S-35). It has BYPASSRLS, because the job
 * works across every tenant, so only the job's route and the Meta webhook's
 * (src/app/api/webhooks/whatsapp) may open it: ESLint keeps it to the files listed as systemSeam
 * in eslint.config.mjs. What it can touch is limited column by column in
 * Postgres (migration 0031). Whatever acts on one booking still names its
 * restaurant_id.
 */
export function getSystemDb(): Database {
  if (!database) {
    const env = getEnv();
    if (!env.DATABASE_URL_SYSTEM) {
      throw new Error("DATABASE_URL_SYSTEM is missing, so the scheduled job can't run.");
    }
    database = createDatabase({
      connectionString: env.DATABASE_URL_SYSTEM,
      wsProxy: env.NEON_WS_PROXY,
    }).db;
  }
  return database;
}
