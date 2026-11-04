CREATE TABLE "closures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text,
	CONSTRAINT "closures_restaurant_id_id_unique" UNIQUE("restaurant_id","id"),
	CONSTRAINT "closures_times_ordered" CHECK ("closures"."starts_at" < "closures"."ends_at"),
	CONSTRAINT "closures_reason" CHECK ("closures"."reason" is null or (trim("closures"."reason") <> '' and length("closures"."reason") <= 200))
);
--> statement-breakpoint
ALTER TABLE "closures" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "closures" ADD CONSTRAINT "closures_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "closures_restaurant_id_ends_at_index" ON "closures" USING btree ("restaurant_id","ends_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "closures" AS PERMISSIVE FOR ALL TO public USING ("restaurant_id" = nullif(current_setting('app.restaurant_id', true), '')::uuid) WITH CHECK ("restaurant_id" = nullif(current_setting('app.restaurant_id', true), '')::uuid);--> statement-breakpoint
-- Not in the Drizzle schema, which can't model triggers (see schema.ts, closures).
-- Spec 04's closures, in Postgres because they protect seats: a closure can't be
-- saved over a confirmed booking, and a confirmed booking can't be made inside a
-- closure, whichever of the two commits first.
--
-- "Covers" *(proposed)* is judged on the sitting, [starts_at, ends_at), never the
-- hold. That is what the availability engine drops a time for ("[t, t + sitting)
-- overlaps any closure", spec 04), so the list, confirm and this guard agree; the
-- reset buffer after a sitting is the restaurant's own time and may run into a
-- closure. Only a `confirmed` booking is in the way of a closure (spec 04 says
-- "existing confirmed bookings"), and only one whose sitting hasn't ended: a
-- seated party is already at the table and staff finish it, and a past one is
-- history. For the same reason only a confirmed booking is refused inside a
-- closure: a walk-in is seated, and staff seat who is at the door.
-- booking_stops_closure is the one definition of that, so the screen's list and the
-- refusal can't disagree.
CREATE FUNCTION booking_stops_closure(p_status booking_status, p_ends_at timestamptz) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p_status = 'confirmed' AND p_ends_at > now()
$$;
--> statement-breakpoint
-- THE RACE, as for the archive guard (migration 0023): a closure insert and a
-- booking insert don't conflict on any row, so each could pass its check without
-- seeing the other's uncommitted row. They meet on an advisory lock of their own,
-- keyed by the restaurant: a booking holds it shared (confirms never queue behind
-- each other), a closure save holds it exclusive (it waits for the confirms in
-- flight, and they wait for it). Per restaurant, because a closure is any range of
-- time and can't be keyed by a table or a day; it is held only across the save.
-- Transaction-level, so it ends with the transaction.
--
-- Each side takes the lock in one statement and judges in the next, so whoever
-- waited sees what the other committed (READ COMMITTED takes a snapshot per
-- statement). Both are AFTER triggers, so RLS's WITH CHECK has already refused a row
-- forged for another restaurant, and SECURITY DEFINER so the judgement sees every
-- booking and closure whatever the caller's RLS shows. They use only the row that
-- was written and quote nothing of it in the error.
--
-- LOCK ORDER. A booking insert takes, in trigger-name order, the phone's lock
-- (0024), the table's lock shared (0023) and then this one shared. The closure
-- save takes this one and no other advisory lock, and never waits on a row the
-- other side holds, so no wait can close a cycle: a table archive holds the
-- table's lock and nothing else, and the gate's recheck takes the settings row.
-- src/db/booking-lock-order.int.test.ts holds that to the real connections.
--
-- Reads are bounded. The booking read below stops looking back at 960 minutes
-- before the later of the closure's start and now: bookings_hold_capped (0022)
-- means no sitting outlasts its start by more, so nothing older can still be in the
-- way, and bookings are never deleted. The closure read starts at the booking's
-- start, through the index on (restaurant_id, ends_at).
CREATE FUNCTION closures_cover_bookings() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  from_instant timestamptz := greatest(NEW.starts_at, now());
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('closure_seat:' || NEW.restaurant_id::text, 0));
  IF EXISTS (
    SELECT FROM public.bookings b
    WHERE b.restaurant_id = NEW.restaurant_id
      AND b.starts_at > from_instant - interval '960 minutes'
      AND b.starts_at < NEW.ends_at
      AND b.ends_at > from_instant
      AND public.booking_stops_closure(b.status, b.ends_at)
  ) THEN
    RAISE EXCEPTION 'a closure can''t cover confirmed bookings'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'closures_cover_bookings';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION closures_cover_bookings() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER closures_cover_bookings
  AFTER INSERT OR UPDATE OF starts_at, ends_at ON closures
  FOR EACH ROW
  EXECUTE FUNCTION closures_cover_bookings();
--> statement-breakpoint
CREATE FUNCTION bookings_within_closure() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('closure_seat:' || NEW.restaurant_id::text, 0));
  IF EXISTS (
    SELECT FROM public.closures c
    WHERE c.restaurant_id = NEW.restaurant_id
      AND c.ends_at > NEW.starts_at
      AND c.starts_at < NEW.ends_at
  ) THEN
    RAISE EXCEPTION 'a booking can''t be made inside a closure'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bookings_within_closure';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION bookings_within_closure() FROM PUBLIC;
--> statement-breakpoint
-- Named to sort after bookings_table_live_insert (0023), so an insert goes phone,
-- table, closure. A new confirmed booking, online or staff.
CREATE TRIGGER bookings_within_closure_insert
  AFTER INSERT ON bookings
  FOR EACH ROW WHEN (NEW.status = 'confirmed')
  EXECUTE FUNCTION bookings_within_closure();
--> statement-breakpoint
-- A booking reopened (cancelled or no-show back to confirmed), or one whose time
-- changes while confirmed, is a new claim on the time. A seating, a finish, a
-- cancel or a move to another table never takes this lock.
CREATE TRIGGER bookings_within_closure_update
  AFTER UPDATE OF status, starts_at, ends_at ON bookings
  FOR EACH ROW WHEN (
    NEW.status = 'confirmed'
    AND (OLD.status <> 'confirmed' OR OLD.starts_at <> NEW.starts_at OR OLD.ends_at <> NEW.ends_at)
  )
  EXECUTE FUNCTION bookings_within_closure();
