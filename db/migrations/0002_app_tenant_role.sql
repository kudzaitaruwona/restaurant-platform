-- app_tenant is the role the app connects as (DATABASE_URL). RLS only means
-- something for a role that is not a superuser, has no BYPASSRLS and owns no
-- table, so the role that runs these migrations is not it.
--
-- It starts NOLOGIN with no password, so no secret lives in a migration:
-- `npm run db:migrate` then turns on LOGIN with the password from DATABASE_URL
-- (src/db/app-role.ts). Roles are per cluster, not per database, hence the
-- guard: restaurant_dev and restaurant_test share one locally.
--
-- On Neon it has to be created with SQL like this. A role created in the Neon
-- Console, CLI or API joins neon_superuser, which is not what we want here.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_tenant') THEN
    CREATE ROLE app_tenant NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_tenant;
--> statement-breakpoint
-- Tenants are created by the platform, not from inside one, and nothing
-- customer-facing is hard-deleted (spec 00).
GRANT SELECT, UPDATE ON restaurants TO app_tenant;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON staff TO app_tenant;
--> statement-breakpoint
-- Later tables work without a GRANT in every migration. RLS is what limits
-- them, and src/db/rls.int.test.ts fails if one arrives without it. This covers
-- objects created by the role running migrations, which is the only role that
-- creates any.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_tenant;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_tenant;
