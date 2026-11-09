import "server-only";
import { getEnv } from "@/lib/env";
import { createDatabase, type Database } from "./client";

let database: Database | undefined;

/**
 * Staff sign-in's database: its own login and its own pool, on
 * DATABASE_URL_STAFF_AUTH (S-28, S-30). Only this role can touch staff_auth_*,
 * where a magic link is only a row, or look an email up across tenants
 * (staff_identity_by_email), so only sign-in may open it: ESLint keeps it to the files listed as staffAuthSeam in
 * eslint.config.mjs. Tenant data isn't here.
 */
export function getStaffAuthDb(): Database {
  if (!database) {
    const env = getEnv();
    if (!env.DATABASE_URL_STAFF_AUTH) {
      throw new Error("DATABASE_URL_STAFF_AUTH is missing, so no staff member can sign in.");
    }
    database = createDatabase({
      connectionString: env.DATABASE_URL_STAFF_AUTH,
      wsProxy: env.NEON_WS_PROXY,
    }).db;
  }
  return database;
}
