ALTER TABLE "order_items" ADD COLUMN "change_xid" bigint DEFAULT (pg_current_xact_id()::text::bigint) NOT NULL;--> statement-breakpoint
CREATE INDEX "order_items_changes" ON "order_items" USING btree ("restaurant_id","change_xid");--> statement-breakpoint
-- THE KITCHEN BOARD'S CHANGE STAMP (#71, proposed). A poll asks for the lines
-- changed since its last one. A timestamp can't answer that: now() is when a
-- transaction started, so a write stamped before a poll's cutoff but committed
-- after it is skipped for good. The writer's transaction id can: every
-- transaction a poll's snapshot can't see has an id at or above that snapshot's
-- xmin, so the next poll, asking for stamps >= that xmin, finds it once it has
-- committed (src/lib/kitchen.ts). BEFORE, so the stamp is the database's
-- whatever the writer sent: a row can't hide behind an old stamp.
CREATE FUNCTION order_items_change_stamp() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW.change_xid := pg_current_xact_id()::text::bigint;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION order_items_change_stamp() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER order_items_change_stamp
  BEFORE INSERT OR UPDATE ON order_items
  FOR EACH ROW EXECUTE FUNCTION order_items_change_stamp();
