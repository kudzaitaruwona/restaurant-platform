-- Narrows what 0032 gave the scheduled job (app_system, BYPASSRLS) for D-06's
-- phone purge, after the security review of ticket 43. 0032 let it read every
-- guest's number in every tenant, only so the purge could filter on
-- guest_phone is not null, and its UPDATE (guest_phone) grant let it write any
-- number, not just null. Here: a stored generated column says whether a number is
-- there, the purge's partial index moves onto it, and the job reads that column
-- instead of the number.
DROP INDEX "bookings_phone_starts_at_index";--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "guest_phone_set" boolean GENERATED ALWAYS AS (guest_phone is not null) STORED NOT NULL;--> statement-breakpoint
CREATE INDEX "bookings_phone_set_starts_at_index" ON "bookings" USING btree ("starts_at") WHERE "bookings"."guest_phone_set";

--> statement-breakpoint
-- The job reads whether a number is there, never the number. UPDATE (guest_phone)
-- stays: UPDATE ... SET guest_phone = null WHERE guest_phone_set needs no SELECT on
-- guest_phone, and Postgres recomputes guest_phone_set itself.
REVOKE SELECT (guest_phone) ON bookings FROM app_system;
--> statement-breakpoint
GRANT SELECT (guest_phone_set) ON bookings TO app_system;
--> statement-breakpoint
-- A column grant can't say "only to null", so this does: app_system may clear a
-- guest's number and never write one. Without it, SQL run as that login could
-- point any upcoming booking in any tenant at another number, and spec 05's
-- confirmations and reminders would go there. SECURITY INVOKER and owned by the
-- migration role; app_system can't drop or disable it (it owns nothing) and can't
-- set session_replication_role (that takes a superuser). It looks at
-- current_user, so a role that SET ROLEs to app_system is held to it too. Nothing
-- else in the app is affected: the app's own logins never match it.
CREATE FUNCTION bookings_system_phone_null_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'app_system may only null a booking''s guest_phone'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION bookings_system_phone_null_only() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER bookings_system_phone_null_only
  BEFORE INSERT OR UPDATE OF guest_phone ON bookings
  FOR EACH ROW WHEN (current_user = 'app_system' AND NEW.guest_phone IS NOT NULL)
  EXECUTE FUNCTION bookings_system_phone_null_only();
