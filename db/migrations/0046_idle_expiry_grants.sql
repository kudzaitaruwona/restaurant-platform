-- IDLE EXPIRY (spec 06, Sessions; S-35; #75). The scheduled job closes an open
-- session with no activity for 90 minutes once every line is delivered or
-- voided (src/lib/cron/idle-expiry.ts). It runs as app_system, which bypasses
-- RLS across every restaurant, so it is granted columns, not tables (S-28 in
-- detail), and only what this task reads and writes:
--  - table_sessions: which session (restaurant_id, id), whether it is open and
--    when it was last active, to find it; status, closed_at and close_reason to
--    close it. Not table_id, closed_by or the waiter call: closed_by stays null
--    (an automatic close), and table_sessions_waiter_flag clears the call itself.
--  - orders and order_items: which orders belong to the session and whether each
--    line is in play (the stored generated column, 0042), to skip a session the
--    closure gate would refuse. Never the customer's name, a note, an item or a
--    price.
-- The closure gate (0045) still holds for it: it is SECURITY DEFINER, so it sees
-- every line whatever this login may read.
--
-- No new index. The job finds open sessions across restaurants on
-- table_sessions_one_open_per_table (partial, WHERE status = 'open'), which holds
-- only open sessions, so it never reads closed ones. An index on last_activity_at
-- would make every activity bump (scans, orders, kitchen moves) a non-HOT update.
GRANT SELECT (restaurant_id, id, status, last_activity_at),
  UPDATE (status, closed_at, close_reason)
  ON table_sessions TO app_system;
--> statement-breakpoint
GRANT SELECT (restaurant_id, id, session_id) ON orders TO app_system;
--> statement-breakpoint
GRANT SELECT (restaurant_id, order_id, in_play) ON order_items TO app_system;
