import { migrate } from "drizzle-orm/neon-serverless/migrator";
import { createDatabase, type DatabaseSettings } from "./client";

export const migrationsFolder = "db/migrations";

/** Applies every pending migration in db/migrations, in order. */
export async function runMigrations(settings: DatabaseSettings) {
  const { db, pool } = createDatabase(settings);
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await pool.end();
  }
}
