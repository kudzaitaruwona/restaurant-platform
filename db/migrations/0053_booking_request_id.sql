ALTER TABLE "bookings" ADD COLUMN "request_id" uuid;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_request_once" UNIQUE("restaurant_id","request_id");--> statement-breakpoint
-- Not in the Drizzle schema, which can't model triggers. bookings_request_once says a
-- submission books once (#134); this keeps it so: clearing or changing a booking's
-- request_id, whoever asks, would let the same submission book again. A cancelled
-- booking keeps its id too, so a retry that arrives late can't undo the cancel.
CREATE FUNCTION bookings_request_frozen() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'the submission a booking came from can''t change'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'bookings_request_frozen';
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION bookings_request_frozen() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER bookings_request_frozen
  BEFORE UPDATE ON bookings
  FOR EACH ROW WHEN (OLD.request_id IS DISTINCT FROM NEW.request_id)
  EXECUTE FUNCTION bookings_request_frozen();
