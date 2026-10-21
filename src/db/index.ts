import "server-only";
import { getEnv } from "@/lib/env";
import { createDatabase, type Database } from "./client";

let database: Database | undefined;

/**
 * The app's database: one Neon WebSocket pool per server instance, on the
 * pooled DATABASE_URL. Tenant-scoped access goes through the tenant seam
 * (S-25) once it exists.
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
