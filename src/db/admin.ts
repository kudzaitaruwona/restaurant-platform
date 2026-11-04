import "server-only";
import { getEnv } from "@/lib/env";
import { createDatabase, type Database } from "./client";

let database: Database | undefined;

/**
 * The admin path's database: its own login and its own pool, on
 * DATABASE_URL_ADMIN (S-28). Only this role can call the platform_* functions or
 * touch admin_auth_*, so only the admin seam may open it: ESLint keeps it to the
 * files listed as adminSeam in eslint.config.mjs. Tenant data isn't here. An
 * admin inside a restaurant works through withTenant() like anyone else.
 */
export function getAdminDb(): Database {
  if (!database) {
    const env = getEnv();
    if (!env.DATABASE_URL_ADMIN) {
      throw new Error("DATABASE_URL_ADMIN is missing, so nothing on the admin path can run.");
    }
    database = createDatabase({
      connectionString: env.DATABASE_URL_ADMIN,
      wsProxy: env.NEON_WS_PROXY,
    }).db;
  }
  return database;
}
