CREATE TABLE "booking_rate_limit" (
	"key" text PRIMARY KEY NOT NULL,
	"attempts" integer NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "booking_rate_limit" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "outside_tenant_only" ON "booking_rate_limit" AS PERMISSIVE FOR ALL TO public USING (nullif(current_setting('app.restaurant_id', true), '') is null) WITH CHECK (nullif(current_setting('app.restaurant_id', true), '') is null);--> statement-breakpoint
-- The per-phone limit (spec 04, abuse controls, proposed). It protects seats: one
-- phone number can't hold more than max_active_bookings_per_phone future bookings
-- at a restaurant. The app counts first, to answer with the guest's own number,
-- but the count alone is a race: two confirms for one phone each count 1 and each
-- insert a second. So this is the rule, in Postgres. Not in the Drizzle schema
-- (which can't model triggers).
--
-- It takes a transaction-scoped advisory lock per (restaurant, phone) and then
-- counts in a statement of its own. The second confirm waits at the lock until the
-- first commits or rolls back, and its count, a new statement, then sees the
-- first's row: exactly one passes the last place. The count includes the row just
-- written, so the refusal is "more than allowed".
--
-- AFTER, so RLS's WITH CHECK has already refused a row forged for another
-- restaurant, and SECURITY INVOKER, so it reads only what the caller may see. It
-- covers online bookings only: staff may add past the limit (spec 04), and a
-- booking with no phone (walk-ins, staff) has nothing to count. A hash collision
-- between two phones only makes them queue behind each other. The exception aborts
-- the statement, so the insert is gone, and it is no exclusion violation, so
-- firstTableToTake lets it through to confirmBooking, which answers it.
CREATE FUNCTION bookings_max_active_per_phone() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  allowed integer;
  held integer;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.restaurant_id::text || ':' || NEW.guest_phone, 0)
  );
  SELECT max_active_bookings_per_phone INTO allowed
  FROM public.booking_settings WHERE restaurant_id = NEW.restaurant_id;
  SELECT count(*) INTO held
  FROM public.bookings
  WHERE restaurant_id = NEW.restaurant_id
    AND guest_phone = NEW.guest_phone
    AND status = 'confirmed'
    AND starts_at > now();
  IF held > allowed THEN
    RAISE EXCEPTION 'too many upcoming bookings for one phone number'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'bookings_max_active_per_phone';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION bookings_max_active_per_phone() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER bookings_max_active_per_phone
  AFTER INSERT ON bookings
  FOR EACH ROW WHEN (NEW.source = 'online' AND NEW.status = 'confirmed' AND NEW.guest_phone IS NOT NULL)
  EXECUTE FUNCTION bookings_max_active_per_phone();
