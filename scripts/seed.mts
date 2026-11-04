/**
 * `npm run db:seed`: the development identities behind DEV_AUTH_BYPASS (S-25),
 * written through DATABASE_URL_UNPOOLED, the role that owns the tables.
 */
import nextEnv from "@next/env";
import { createDatabase } from "../src/db/client";
import { seedDevData } from "../src/db/seed";

nextEnv.loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");

const connectionString = process.env.DATABASE_URL_UNPOOLED;
if (!process.env.DEV_AUTH_BYPASS || !connectionString) {
  console.error(
    "The seed is for development: set DEV_AUTH_BYPASS and DATABASE_URL_UNPOOLED. See .env.example.",
  );
  process.exit(1);
}
if (process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production") {
  console.error("Refusing to seed development identities in production.");
  process.exit(1);
}

const { db, pool } = createDatabase({
  connectionString,
  wsProxy: process.env.NEON_WS_PROXY || undefined,
});
try {
  await seedDevData(db);
} finally {
  await pool.end();
}
console.log("Seeded restaurants A and B, each with an owner and a staff member.");
