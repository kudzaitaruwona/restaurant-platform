-- Not in the Drizzle schema, which can't model triggers (see schema.ts, bookings).
-- Spec 03's archive guard, in Postgres because it protects seats: a table with
-- future bookings can't be archived, and a booking can't be made on an archived
-- table, whichever of the two commits first.
--
-- "Future" *(proposed)*: a booking holds its table while it is confirmed or
-- seated and its hold hasn't ended. Judged by hold_ends_at, not starts_at, so a
-- table that is occupied now (seated, or a guest running late whose booking is
-- still confirmed) counts, and so does the reset buffer after a seating.
-- completed, cancelled and no_show never hold a table for this purpose.
--
-- The guard below and the app's list (src/lib/tables.ts) read back only 960 minutes
-- from now, so an archive doesn't walk the table's whole booking history.
-- bookings_hold_capped (migration 0015) makes that safe: a hold ends within 960
-- minutes of its start, so a booking that started earlier can't still hold a table.
-- Raising the cap means raising these two bounds with it.
CREATE FUNCTION booking_holds_table(p_status booking_status, p_hold_ends_at timestamptz) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p_status IN ('confirmed', 'seated') AND p_hold_ends_at > now()
$$;
--> statement-breakpoint
-- THE RACE. A booking insert's foreign key check takes KEY SHARE on the table's
-- row, and an archive UPDATE takes NO KEY UPDATE: they don't conflict, so a
-- confirm and an archive could each pass its check, neither seeing the other's
-- uncommitted row. Strengthening the row lock would fix that, but moveTable holds
-- NO KEY UPDATE on every live table precisely so that confirms don't queue behind
-- it, and a stronger lock on the insert side (FOR SHARE) would bring that back.
-- So the two sides meet on a lock of their own instead, an advisory lock keyed by
-- the table: an insert holds it shared (inserts never queue behind each other),
-- an archive holds it exclusive (it waits for inserts in flight and they wait for
-- it). Transaction-level, so it ends with the transaction, and it touches nothing
-- else: the row locks are as they were.
--
-- Each side takes the lock in one statement and judges in the next. Under READ
-- COMMITTED a statement's snapshot is taken when it starts, so whoever waited sees
-- what the other committed. Both triggers are AFTER, and SECURITY DEFINER so the
-- judgement sees every booking whatever the caller's RLS shows; they use only the
-- row that was written (RLS's WITH CHECK has already refused a forged
-- restaurant_id) and quote nothing of it in the error.
CREATE FUNCTION tables_archive_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('table_seat:' || NEW.id::text, 0));
  IF EXISTS (
    SELECT FROM public.bookings b
    WHERE b.restaurant_id = NEW.restaurant_id
      AND b.table_id = NEW.id
      AND b.starts_at > now() - interval '960 minutes'
      AND public.booking_holds_table(b.status, b.hold_ends_at)
  ) THEN
    RAISE EXCEPTION 'a table with upcoming bookings can''t be archived'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'tables_archive_guard';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION tables_archive_guard() FROM PUBLIC;
--> statement-breakpoint
-- Named to sort before booking_gate_table_changed (migration 0014): triggers fire
-- in name order, so a refused archive stops before the gate's recheck has taken the
-- settings row's lock. The two compose either way, since the refusal aborts the
-- statement and the recheck's switch-off with it.
CREATE TRIGGER booking_archive_guard
  AFTER UPDATE OF archived_at ON tables
  FOR EACH ROW WHEN (OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL)
  EXECUTE FUNCTION tables_archive_guard();
--> statement-breakpoint
-- The insert side: a booking that holds its table needs a table that is live. An
-- online booking also needs it bookable, which spec 03 defines as "in online
-- booking"; staff bookings and walk-ins may use a walk-in-only table. That check
-- takes no lock of its own: a booking racing a bookable=false edit can land either
-- side of it. When this refuses, the app takes the table as gone and tries the next.
CREATE FUNCTION bookings_table_live() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  seat record;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('table_seat:' || NEW.table_id::text, 0));
  SELECT t.archived_at, t.bookable INTO seat
  FROM public.tables t
  WHERE t.restaurant_id = NEW.restaurant_id AND t.id = NEW.table_id;
  IF FOUND AND seat.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'a booking can''t hold an archived table'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bookings_table_live';
  END IF;
  IF FOUND AND NEW.source = 'online' AND NOT seat.bookable THEN
    RAISE EXCEPTION 'an online booking can''t hold a walk-in-only table'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bookings_table_bookable';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION bookings_table_live() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER bookings_table_live_insert
  AFTER INSERT ON bookings
  FOR EACH ROW WHEN (booking_holds_table(NEW.status, NEW.hold_ends_at))
  EXECUTE FUNCTION bookings_table_live();
--> statement-breakpoint
-- A booking moved to another table, or reopened (cancelled back to confirmed), is
-- a new claim on a table. One that already held its table and stays on it isn't:
-- a seating, a finish or the job's status changes never take this lock.
CREATE TRIGGER bookings_table_live_update
  AFTER UPDATE OF table_id, status ON bookings
  FOR EACH ROW WHEN (
    booking_holds_table(NEW.status, NEW.hold_ends_at)
    AND (NEW.table_id <> OLD.table_id OR NOT booking_holds_table(OLD.status, OLD.hold_ends_at))
  )
  EXECUTE FUNCTION bookings_table_live();
