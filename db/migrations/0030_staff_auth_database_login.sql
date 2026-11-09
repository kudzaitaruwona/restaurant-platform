-- Staff sign-in's own login, as admin_database_login gave the admin path one
-- (S-28, S-30). Until now Better Auth's staff audience ran as app_tenant, the
-- login every tenant query uses. A magic link is only a row in
-- staff_auth_verification, so SQL run as app_tenant could clear
-- app.restaurant_id, plant a working link for any staff member and become an
-- owner of any restaurant. The outside_tenant_only policy can't stop that: the
-- same SQL can clear the setting. app_staff_auth takes all of it away from
-- app_tenant. Only sign-in connects as app_staff_auth (DATABASE_URL_STAFF_AUTH,
-- src/db/staff-auth.ts).
--
-- Like app_tenant and app_admin it starts NOLOGIN with no password, so no secret
-- lives here: `npm run db:migrate` turns on LOGIN with the password from
-- DATABASE_URL_STAFF_AUTH and fails if RLS wouldn't apply to it
-- (src/db/app-role.ts). The guard is because roles are per cluster, not per
-- database. On Neon it has to be created with SQL like this: one made in the
-- Console joins neon_superuser.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_staff_auth') THEN
    CREATE ROLE app_staff_auth NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_staff_auth;
--> statement-breakpoint
-- app_tenant keeps nothing: 0002's default privileges gave it all of these, and
-- they'll give it the next one too, which src/db/staff-auth-role.int.test.ts
-- refuses.
REVOKE ALL ON
  staff_auth_user, staff_auth_session, staff_auth_account,
  staff_auth_verification, staff_auth_rate_limit, staff_auth_code_limit
FROM app_tenant;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON
  staff_auth_user, staff_auth_session, staff_auth_account,
  staff_auth_verification, staff_auth_rate_limit, staff_auth_code_limit
TO app_staff_auth;
--> statement-breakpoint
-- Who an email belongs to: sign-in asks before letting anyone in, and
-- getTenantContext() asks on every request, right after reading the session
-- through this same login. Moving it rather than sharing it keeps one caller per
-- function, and leaves app_tenant no way to map an email to a restaurant.
REVOKE EXECUTE ON FUNCTION public.staff_identity_by_email(text) FROM app_tenant;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.staff_identity_by_email(text) TO app_staff_auth;
