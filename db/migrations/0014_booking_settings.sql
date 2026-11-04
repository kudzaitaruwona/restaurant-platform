CREATE TABLE "booking_settings" (
	"restaurant_id" uuid PRIMARY KEY NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"slot_interval_minutes" integer DEFAULT 15 NOT NULL,
	"sitting_minutes" integer DEFAULT 90 NOT NULL,
	"large_party_size" integer DEFAULT 5 NOT NULL,
	"large_party_sitting_minutes" integer DEFAULT 120 NOT NULL,
	"buffer_minutes" integer DEFAULT 15 NOT NULL,
	"min_lead_minutes" integer DEFAULT 60 NOT NULL,
	"max_days_ahead" integer DEFAULT 30 NOT NULL,
	"max_online_party_size" integer DEFAULT 8 NOT NULL,
	"guest_cancel_cutoff_minutes" integer DEFAULT 120 NOT NULL,
	"max_active_bookings_per_phone" integer DEFAULT 2 NOT NULL,
	CONSTRAINT "booking_settings_restaurant_id_id_unique" UNIQUE("restaurant_id","id"),
	CONSTRAINT "booking_settings_slot_interval" CHECK ("booking_settings"."slot_interval_minutes" between 1 and 240),
	CONSTRAINT "booking_settings_sitting" CHECK ("booking_settings"."sitting_minutes" between 1 and 720),
	CONSTRAINT "booking_settings_large_party_size" CHECK ("booking_settings"."large_party_size" between 1 and 100),
	CONSTRAINT "booking_settings_large_party_sitting" CHECK ("booking_settings"."large_party_sitting_minutes" between 1 and 720),
	CONSTRAINT "booking_settings_buffer" CHECK ("booking_settings"."buffer_minutes" between 0 and 240),
	CONSTRAINT "booking_settings_min_lead" CHECK ("booking_settings"."min_lead_minutes" between 0 and 10080),
	CONSTRAINT "booking_settings_max_days_ahead" CHECK ("booking_settings"."max_days_ahead" between 0 and 365),
	CONSTRAINT "booking_settings_max_online_party_size" CHECK ("booking_settings"."max_online_party_size" between 1 and 100),
	CONSTRAINT "booking_settings_cancel_cutoff" CHECK ("booking_settings"."guest_cancel_cutoff_minutes" between 0 and 10080),
	CONSTRAINT "booking_settings_max_active_per_phone" CHECK ("booking_settings"."max_active_bookings_per_phone" between 1 and 20)
);
--> statement-breakpoint
ALTER TABLE "booking_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "service_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"weekday" integer NOT NULL,
	"opens_at" time NOT NULL,
	"last_booking_at" time NOT NULL,
	"closes_at" time NOT NULL,
	CONSTRAINT "service_periods_restaurant_id_id_unique" UNIQUE("restaurant_id","id"),
	CONSTRAINT "service_periods_weekday" CHECK ("service_periods"."weekday" between 0 and 6),
	CONSTRAINT "service_periods_name" CHECK (trim("service_periods"."name") <> '' and length("service_periods"."name") <= 50),
	CONSTRAINT "service_periods_times_ordered" CHECK ("service_periods"."opens_at" <= "service_periods"."last_booking_at" and "service_periods"."last_booking_at" < "service_periods"."closes_at"),
	CONSTRAINT "service_periods_same_day" CHECK ("service_periods"."closes_at" <= '23:59')
);
--> statement-breakpoint
ALTER TABLE "service_periods" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "booking_settings" ADD CONSTRAINT "booking_settings_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_periods" ADD CONSTRAINT "service_periods_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "booking_settings" AS PERMISSIVE FOR ALL TO public USING ("restaurant_id" = nullif(current_setting('app.restaurant_id', true), '')::uuid) WITH CHECK ("restaurant_id" = nullif(current_setting('app.restaurant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "service_periods" AS PERMISSIVE FOR ALL TO public USING ("restaurant_id" = nullif(current_setting('app.restaurant_id', true), '')::uuid) WITH CHECK ("restaurant_id" = nullif(current_setting('app.restaurant_id', true), '')::uuid);--> statement-breakpoint
-- Not in the Drizzle schema, which can't model exclusion constraints (see
-- schema.ts, servicePeriods). No two periods on a weekday may overlap. It leads
-- with restaurant_id (btree_gist, migration 0000), like every tenant rule. The
-- ranges are half-open, in seconds since midnight, so one period may close at
-- the minute the next one opens. The times are `time` without a zone, so the
-- expression is immutable; the zone comes in with restaurants.timezone when the
-- availability engine turns a period into instants.
ALTER TABLE "service_periods" ADD CONSTRAINT "service_periods_no_overlap"
  EXCLUDE USING gist (
    "restaurant_id" WITH =,
    "weekday" WITH =,
    int4range(extract(epoch from "opens_at")::int, extract(epoch from "closes_at")::int) WITH &&
  );
--> statement-breakpoint
-- One booking_settings row per restaurant, with spec 00's defaults: made when
-- the restaurant is, and now for the restaurants that exist. SECURITY DEFINER
-- because the platform's create-restaurant function runs outside any tenant, so
-- RLS would refuse the insert. Only the trigger can call it.
CREATE FUNCTION booking_settings_for_new_restaurant() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  INSERT INTO public.booking_settings (restaurant_id) VALUES (NEW.id);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION booking_settings_for_new_restaurant() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER booking_settings_for_new_restaurant
  AFTER INSERT ON restaurants
  FOR EACH ROW EXECUTE FUNCTION booking_settings_for_new_restaurant();
--> statement-breakpoint
INSERT INTO booking_settings (restaurant_id) SELECT id FROM restaurants;
--> statement-breakpoint
-- The enable gate (spec 04 › Settings): online booking is on only while the
-- restaurant has a service period, a bookable table that isn't archived, and a
-- contact phone. What is missing, as the names the app turns into words.
-- VOLATILE plpgsql on purpose: each query takes a fresh READ COMMITTED snapshot,
-- so a caller that waited on a lock sees what the other transaction committed.
-- Not SECURITY DEFINER itself: only the definer trigger functions below call it,
-- so it runs as their owner and sees the whole restaurant whatever the tenant's
-- RLS context, and nobody else can run it (EXECUTE is revoked), which a definer
-- function would have to allow for the app role. search_path is pinned all the same.
CREATE FUNCTION booking_gate_missing(p_restaurant_id uuid) RETURNS text[]
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  missing text[] := '{}';
BEGIN
  IF NOT EXISTS (
    SELECT FROM public.service_periods WHERE restaurant_id = p_restaurant_id
  ) THEN
    missing := array_append(missing, 'service_period');
  END IF;
  IF NOT EXISTS (
    SELECT FROM public.tables
    WHERE restaurant_id = p_restaurant_id AND bookable AND archived_at IS NULL
  ) THEN
    missing := array_append(missing, 'table');
  END IF;
  IF NOT EXISTS (
    SELECT FROM public.restaurants
    WHERE id = p_restaurant_id AND contact_phone IS NOT NULL
  ) THEN
    missing := array_append(missing, 'contact_phone');
  END IF;
  RETURN missing;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION booking_gate_missing(uuid) FROM PUBLIC;
--> statement-breakpoint
-- Turning booking on is refused while anything is missing. AFTER, not BEFORE:
-- Postgres applies RLS's WITH CHECK before it writes a row and after BEFORE
-- triggers, so a row forged for another restaurant is refused by the policy and
-- this definer function never reports on that restaurant. By the time it runs
-- the UPDATE has written the row and holds its lock until the transaction ends,
-- so an owner enabling and another archiving the last table are queued on that
-- row: whichever commits second sees the other's result (the recheck below is the
-- archiving side). The exception aborts the statement, as it would from BEFORE.
CREATE FUNCTION booking_settings_enable_gate() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  missing text[] := public.booking_gate_missing(NEW.restaurant_id);
BEGIN
  IF cardinality(missing) > 0 THEN
    RAISE EXCEPTION 'online booking can''t be enabled for restaurant %', NEW.restaurant_id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'booking_settings_enable_gate',
            DETAIL = array_to_string(missing, ',');
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION booking_settings_enable_gate() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER booking_settings_enable_gate_insert
  AFTER INSERT ON booking_settings
  FOR EACH ROW WHEN (NEW.enabled)
  EXECUTE FUNCTION booking_settings_enable_gate();
--> statement-breakpoint
CREATE TRIGGER booking_settings_enable_gate_update
  AFTER UPDATE ON booking_settings
  FOR EACH ROW WHEN (NEW.enabled AND NOT OLD.enabled)
  EXECUTE FUNCTION booking_settings_enable_gate();
--> statement-breakpoint
-- The other side of the race: when the last service period, the last bookable
-- table or the contact phone goes, booking is switched off with it, so the gate
-- holds at every commit. It first takes the settings row's lock, which waits for
-- an enable in flight, then judges with a fresh snapshot (a second statement, so
-- the wait can't leave it with the old one). Like booking_gate_missing, it is
-- reached only through the definer triggers. Without the lock, enabling at the
-- moment the last table is archived would commit with nothing to book.
CREATE FUNCTION booking_gate_recheck(p_restaurant_id uuid) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM FROM public.booking_settings WHERE restaurant_id = p_restaurant_id FOR UPDATE;
  UPDATE public.booking_settings SET enabled = false
  WHERE restaurant_id = p_restaurant_id
    AND enabled
    AND cardinality(public.booking_gate_missing(p_restaurant_id)) > 0;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION booking_gate_recheck(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION booking_gate_table_changed() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.bookable AND OLD.archived_at IS NULL AND (
    TG_OP = 'DELETE'
    OR NOT NEW.bookable
    OR NEW.archived_at IS NOT NULL
    OR NEW.restaurant_id <> OLD.restaurant_id
  ) THEN
    PERFORM public.booking_gate_recheck(OLD.restaurant_id);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION booking_gate_table_changed() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER booking_gate_table_changed
  AFTER UPDATE OF bookable, archived_at, restaurant_id OR DELETE ON tables
  FOR EACH ROW EXECUTE FUNCTION booking_gate_table_changed();
--> statement-breakpoint
CREATE FUNCTION booking_gate_period_removed() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM public.booking_gate_recheck(OLD.restaurant_id);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION booking_gate_period_removed() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER booking_gate_period_removed
  AFTER DELETE OR UPDATE OF restaurant_id ON service_periods
  FOR EACH ROW EXECUTE FUNCTION booking_gate_period_removed();
--> statement-breakpoint
CREATE FUNCTION booking_gate_phone_cleared() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM public.booking_gate_recheck(NEW.id);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION booking_gate_phone_cleared() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER booking_gate_phone_cleared
  AFTER UPDATE OF contact_phone ON restaurants
  FOR EACH ROW WHEN (OLD.contact_phone IS NOT NULL AND NEW.contact_phone IS NULL)
  EXECUTE FUNCTION booking_gate_phone_cleared();
