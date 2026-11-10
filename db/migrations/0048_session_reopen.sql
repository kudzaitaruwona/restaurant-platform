-- REOPEN (spec 00, Enforced in the database; spec 06, Sessions; S-20; #76).
-- A closed session can be reopened only within 15 minutes of its close, and
-- only if no session has opened on its table since, even one that has itself
-- closed again. Reopening also forgets the close (closed_at, close_reason,
-- closed_by) and resets last_activity_at, so idle expiry doesn't close it again
-- on its next run. All of it here, whoever writes the row: staff's reopen
-- (src/lib/closing.ts) and the owner role alike. Staff-only is the app's part:
-- nothing but the floor view's reopen ever sets a closed session open.
--
-- "Since" is read as "after this session first opened", not "after it closed":
-- a scan whose transaction began a moment before the close committed, and that
-- waited on the table lock until it had, opens a session stamped before
-- closed_at, yet it came after. Only one session can be open on a table, so a
-- session of the table that opened after this one did opened while this one was
-- closed: since its close (or since an earlier close it was reopened from,
-- which this rule would have refused then). The same thing, without the gap.
-- So: this session must still be the table's latest by when it opened.
--
-- Race-safe with a scan. A party that committed first is seen here: under READ
-- COMMITTED this query takes a fresh snapshot. A scan still in flight holds the
-- table lock (table_sessions_one_open_per_table), so the reopen's index entry
-- waits for it and then fails the unique check; a reopen in flight makes the
-- scan wait, and the scan then joins the reopened session. Never two open.
-- REPEATABLE READ keeps the transaction's first snapshot and would miss a party
-- that opened and closed meanwhile, so a reopen under it is refused outright, as
-- a close is (0045). SERIALIZABLE is left to its own conflict checks.
--
-- SECURITY DEFINER so the check sees every session of the table whatever the
-- caller's RLS context or grants; search_path pinned with pg_temp last and the
-- table schema-qualified, as the closure gate. The probe asks for the table's
-- latest session by when it opened (table_latest_session, below), which is this
-- one unless another opened after it.
--
-- table_latest_session reads one entry at the newest end of
-- table_sessions_table_opened (0047), never the table's past, and the table
-- detail asks it the same question (src/lib/closing.ts, lastSessionOf). Its
-- plan is pinned: sequential scans, bitmap scans and sorts are off inside it,
-- so the only plan left is that index read backwards. Left to the statistics,
-- Postgres read the table's whole history in testing, one shape or another:
-- this query on statistics that hadn't yet seen the history, and an EXISTS over
-- "opened since" once they had, as a sequential scan it expected to stop early
-- (rows-read tested in src/lib/reopen.int.test.ts, on both). SECURITY INVOKER: as app_tenant, RLS holds it to the tenant.
CREATE FUNCTION table_latest_session(restaurant uuid, dining_table uuid) RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
SET enable_seqscan = off
SET enable_bitmapscan = off
SET enable_sort = off
AS $$
  SELECT s.id FROM public.table_sessions s
  WHERE s.restaurant_id = restaurant AND s.table_id = dining_table
  ORDER BY s.opened_at DESC
  LIMIT 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION table_latest_session(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION table_latest_session(uuid, uuid) TO app_tenant;
--> statement-breakpoint
CREATE FUNCTION table_sessions_reopen() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF current_setting('transaction_isolation') = 'repeatable read' THEN
    RAISE EXCEPTION 'a session can only be reopened under READ COMMITTED or SERIALIZABLE'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'table_sessions_reopen';
  END IF;
  IF OLD.closed_at IS NULL OR OLD.closed_at <= now() - interval '15 minutes' THEN
    RAISE EXCEPTION 'a session can only be reopened within 15 minutes of closing'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'table_sessions_reopen_window';
  END IF;
  IF public.table_latest_session(OLD.restaurant_id, OLD.table_id) IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'a session can''t be reopened once another has opened on its table'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'table_sessions_reopen_newer_session';
  END IF;
  NEW.closed_at := NULL;
  NEW.close_reason := NULL;
  NEW.closed_by := NULL;
  NEW.last_activity_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION table_sessions_reopen() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER table_sessions_reopen
  BEFORE UPDATE OF status ON table_sessions
  FOR EACH ROW WHEN (OLD.status = 'closed' AND NEW.status = 'open')
  EXECUTE FUNCTION table_sessions_reopen();
