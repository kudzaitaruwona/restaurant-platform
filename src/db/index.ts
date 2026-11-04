import "server-only";
import { getEnv } from "@/lib/env";
import { createDatabase, type Database } from "./client";

let database: Database | undefined;

/**
 * The app's database: one Neon WebSocket pool per server instance, on the
 * pooled DATABASE_URL. This handle has no tenant scoping, so only the tenant
 * seam may use it (S-25): app code calls withTenant from "@/lib/tenant", and
 * ESLint enforces that.
 */
export function getDb(): Database {
  if (!database) {
    const env = getEnv();
    database = createDatabase({
      connectionString: env.DATABASE_URL,
      wsProxy: env.NEON_WS_PROXY,
    }).db;
  }
  return database;
}
