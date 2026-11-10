-- A WAITER CALL ENDS WITH ITS SESSION (#77, proposed). "Call a waiter" sets
-- table_sessions.waiter_requested_at on the table's open session; staff clear it
-- by dismissing it. However a session closes (staff clear, idle expiry, force
-- close, payment), the flag goes with it, so no reader can show a closed session
-- as calling and no closing path has to remember to clear it. BEFORE, so the
-- clear is part of the closing write itself; on INSERT too, so a session can't be
-- born closed and calling. A reopen starts with no call.
CREATE FUNCTION table_sessions_waiter_flag() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.status <> 'open' THEN
    NEW.waiter_requested_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION table_sessions_waiter_flag() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER table_sessions_waiter_flag
  BEFORE INSERT OR UPDATE ON table_sessions
  FOR EACH ROW EXECUTE FUNCTION table_sessions_waiter_flag();
