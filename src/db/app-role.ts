import { sql } from "drizzle-orm";
import { APP_DATABASE_ROLE } from "../lib/env";
import { createDatabase, type Database, type DatabaseSettings } from "./client";

/**
 * Lets a role the app connects as, app_tenant or app_admin, log in with the
 * password from its own connection URL. Migrations create these roles without a
 * password so that no secret is committed; this keeps the URL the one place that
 * password is written down. Safe to re-run, which is also how a password is
 * rotated.
 *
 * Then refuses a role that RLS wouldn't apply to. The migration accepts any
 * existing role of this name, and one created in the Neon Console joins
 * neon_superuser: the app would run with every tenant's rows in view and
 * nothing would look wrong. The tests also pass throwaway roles, because roles
 * are per cluster and they mustn't change the shared ones.
 */
export async function provisionAppRole(
  ownerSettings: DatabaseSettings,
  appConnectionString: string,
  role = APP_DATABASE_ROLE,
) {
  // URL.parse, because a failed `new URL` keeps the whole URL on the error.
  const url = URL.parse(appConnectionString);
  if (url?.username !== role || !url.password) {
    throw new Error(
      `The app's connection URL must log in as ${role}, with a password.`,
    );
  }

  const { db, pool } = createDatabase(ownerSettings);
  let exemptions: string[];
  try {
    // ALTER ROLE takes no bind parameters, so have Postgres quote the password.
    const { rows } = await db.execute(
      sql`select format('alter role %I login password %L', ${role}::text, ${decodeURIComponent(url.password)}::text) as statement`,
    );
    await db.execute(sql.raw(String(rows[0].statement)));
    exemptions = await findRlsExemptions(db, role);
  } catch (error) {
    // Drizzle's error quotes the statement and its parameters, and both hold
    // the password. Pass on only the code, and not as `cause`: Node prints that.
    throw new Error(
      `Could not set up ${role} (${errorCode(error)}). The database's message is left out because it can quote the password.`,
    );
  } finally {
    await pool.end();
  }

  if (exemptions.length > 0) {
    throw new Error(
      `Row-level security would not apply to ${role}: ${exemptions.join("; ")}. Create it with SQL, as the migrations do.`,
    );
  }
}

/**
 * Why RLS would skip this role, if it would: the role itself or any role it
 * belongs to is a superuser, has BYPASSRLS or owns a table. Membership counts
 * because table ownership is inherited, and SET ROLE reaches the rest.
 */
async function findRlsExemptions(db: Database, role: string) {
  const { rows } = await db.execute(sql`
    select r.rolname, r.rolsuper, r.rolbypassrls, owned.any as owns_table
    from pg_roles r
    cross join lateral (
      select exists (
        select from pg_class c
        where c.relowner = r.oid and c.relkind in ('r', 'p')
      ) as any
    ) owned
    where pg_has_role(${role}::name, r.oid, 'member')
      and (r.rolsuper or r.rolbypassrls or owned.any)
  `);
  return rows.map((row) => {
    const reasons = [
      row.rolsuper && "superuser",
      row.rolbypassrls && "BYPASSRLS",
      row.owns_table && "owns a table",
    ];
    return `${row.rolname} (${reasons.filter(Boolean).join(", ")})`;
  });
}

function errorCode(error: unknown) {
  const { cause } = error as { cause?: { code?: unknown } };
  return String(cause?.code ?? (error as { code?: unknown }).code ?? "no code");
}
