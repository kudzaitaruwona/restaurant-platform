-- THE CLOSURE GATE (spec 00, Enforced in the database; spec 06, Sessions; #74).
-- A session can't close while any of its lines is still in play (placed,
-- cooking or done): every line must be delivered or voided first. It holds for
-- every close path, whoever runs it: staff's clear table, idle expiry on the
-- job's own login (6.8), a payment later, and the owner role. Force-close is
-- not an exception to it but a use of it: it voids the outstanding lines, then
-- closes, in one transaction, so the gate passes.
--
-- SECURITY DEFINER so the check sees the whole session whatever the caller's
-- RLS context or grants: a login that may close a session but not read its
-- lines (the job's, which is granted column by column) gets a true answer, not
-- an empty one or a permission error. search_path is pinned with pg_temp last
-- and every table is schema-qualified, so a caller's temp table can't stand in
-- for order_items.
--
-- Race-safe with an order going in. The UPDATE has locked the session's row by
-- the time this AFTER trigger runs, and a line's insert takes the same row FOR
-- SHARE (order_items_session_open), so one waits for the other. A line that
-- committed first is seen here, because under READ COMMITTED this query takes a
-- fresh snapshot; a line that comes second finds the session closed and is
-- refused. REPEATABLE READ keeps the transaction's first snapshot, and a FOR
-- SHARE lock doesn't conflict with it, so a line committed meanwhile would be
-- missed: a close under REPEATABLE READ is refused outright. SERIALIZABLE is
-- left to its own conflict checks, which catch that pair.
--
-- Reads the session's orders on orders_restaurant_id_session_id_placed_at_index
-- and their lines on order_items_restaurant_id_order_id_index, so it never walks
-- the restaurant's history. in_play is the stored generated column (migration
-- 0042): status NOT IN ('delivered', 'voided').
CREATE FUNCTION table_sessions_closure_gate() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF current_setting('transaction_isolation') = 'repeatable read' THEN
    RAISE EXCEPTION 'a session can only be closed under READ COMMITTED or SERIALIZABLE'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'table_sessions_closure_gate';
  END IF;
  IF EXISTS (
    SELECT FROM public.orders o
    JOIN public.order_items i ON i.restaurant_id = o.restaurant_id AND i.order_id = o.id
    WHERE o.restaurant_id = NEW.restaurant_id AND o.session_id = NEW.id AND i.in_play
  ) THEN
    RAISE EXCEPTION 'a session can''t close while it has items that aren''t delivered or voided'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'table_sessions_closure_gate';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION table_sessions_closure_gate() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER table_sessions_closure_gate
  AFTER UPDATE OF status ON table_sessions
  FOR EACH ROW WHEN (OLD.status = 'open' AND NEW.status <> 'open')
  EXECUTE FUNCTION table_sessions_closure_gate();
