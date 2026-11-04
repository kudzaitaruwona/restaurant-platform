import { sql } from "drizzle-orm";
import { APP_DATABASE_ROLE } from "../lib/env";
import { createDatabase, type DatabaseSettings } from "./client";

/**
 * Lets the app role log in, with the password from its own connection URL.
 * Migrations create the role without a password so that no secret is committed;
 * this keeps DATABASE_URL the one place that password is written down. Safe to
 * re-run, which is also how the password is rotated.
 */
export async function provisionAppRole(
  ownerSettings: DatabaseSettings,
  appConnectionString: string,
) {
  const { username, password } = new URL(appConnectionString);
  if (username !== APP_DATABASE_ROLE || !password) {
    throw new Error(
      `The app's connection URL must log in as ${APP_DATABASE_ROLE}, with a password.`,
    );
  }

  const { db, pool } = createDatabase(ownerSettings);
  try {
    // ALTER ROLE takes no bind parameters, so have Postgres quote the password.
    const { rows } = await db.execute(
      sql`select format('alter role %I login password %L', ${username}::text, ${decodeURIComponent(password)}::text) as statement`,
    );
    await db.execute(sql.raw(String(rows[0].statement)));
  } finally {
    await pool.end();
  }
}
