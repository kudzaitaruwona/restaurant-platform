ALTER TABLE "orders" ADD COLUMN "request_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_request_once" UNIQUE("restaurant_id","session_id","request_id");--> statement-breakpoint
-- Not in the Drizzle schema, which can't model triggers. orders_frozen (0040) also
-- holds an order's request_id (#84), whoever asks: clearing or changing it would
-- let the same submission be placed again.
DROP TRIGGER orders_frozen ON orders;
--> statement-breakpoint
CREATE TRIGGER orders_frozen
  BEFORE UPDATE ON orders
  FOR EACH ROW WHEN (
    OLD.session_id IS DISTINCT FROM NEW.session_id
    OR OLD.rate_used IS DISTINCT FROM NEW.rate_used
    OR OLD.request_id IS DISTINCT FROM NEW.request_id
  )
  EXECUTE FUNCTION refuse_frozen_change('orders_frozen');
