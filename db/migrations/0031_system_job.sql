-- The scheduled job (S-35, issue 41). Two partial indexes for its booking status
-- rules, which look across every restaurant for confirmed bookings past their
-- ends_at and seated ones past their hold_ends_at, then its own login.
CREATE INDEX "bookings_confirmed_ends_at_index" ON "bookings" USING btree ("ends_at") WHERE "bookings"."status" = 'confirmed';--> statement-breakpoint
CREATE INDEX "bookings_seated_hold_ends_at_index" ON "bookings" USING btree ("hold_ends_at") WHERE "bookings"."status" = 'seated';
--> statement-breakpoint
-- The job's login, app_system (spec 01, S-28, S-35). The job works across every
-- tenant, so unlike app_tenant, app_admin and app_staff_auth it has BYPASSRLS.
-- That is why it is granted columns, not tables: what the status rules read and
-- write, their audit entries, and the sign-in code rows past their window that
-- S-30 asks the job to prune. No guest's name, phone or manage link, nothing it
-- could rewrite history with, no other table. Later tasks (the outbox, the phone
-- purge) grant what they need in their own migrations. Only the job's route opens
-- it (DATABASE_URL_SYSTEM, src/db/system.ts), and the Meta webhook once it exists.
--
-- Like the other logins it starts NOLOGIN with no password: `npm run db:migrate`
-- turns on LOGIN with the password from DATABASE_URL_SYSTEM, and refuses the role
-- if it is any more than this (provisionSystemRole, src/db/app-role.ts). Making a
-- BYPASSRLS role needs a creator that has BYPASSRLS itself. The guard is because
-- roles are per cluster, not per database.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_system') THEN
    CREATE ROLE app_system NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_system;
--> statement-breakpoint
-- The status rules: find what is due, lock it, move it on. Finish's clamp reads
-- the table, the start and the next booking on that table, and the buffer.
GRANT SELECT (restaurant_id, id, table_id, status, starts_at, ends_at, hold_ends_at),
  UPDATE (status, ends_at, hold_ends_at)
  ON bookings TO app_system;
--> statement-breakpoint
GRANT SELECT (restaurant_id, buffer_minutes) ON booking_settings TO app_system;
--> statement-breakpoint
-- actor_type = system, actor_id null. INSERT only: audit_log is append-only.
GRANT INSERT (restaurant_id, actor_type, actor_id, action, entity_type, entity_id, details)
  ON audit_log TO app_system;
--> statement-breakpoint
-- S-30's retention: a row past its 24-hour window has no further use. The job
-- reads the window, never the address.
GRANT SELECT (window_started_at), DELETE ON staff_auth_code_limit, admin_auth_code_limit TO app_system;
