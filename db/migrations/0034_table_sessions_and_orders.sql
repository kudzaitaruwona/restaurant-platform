CREATE TYPE "public"."order_item_status" AS ENUM('placed', 'cooking', 'done', 'delivered', 'voided');--> statement-breakpoint
CREATE TYPE "public"."paid_currency" AS ENUM('usd', 'zig');--> statement-breakpoint
CREATE TYPE "public"."table_session_close_reason" AS ENUM('in_app_payment', 'staff_clear', 'idle_expiry', 'pos_payment', 'force_close');--> statement-breakpoint
CREATE TYPE "public"."table_session_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."zig_source" AS ENUM('fixed', 'calculated');--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"special_id" uuid,
	"name_snapshot" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_usd" numeric,
	"unit_price_zig" numeric,
	"zig_source" "zig_source",
	"note" text,
	"status" "order_item_status" DEFAULT 'placed' NOT NULL,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"void_reason" text,
	"voided_by" uuid,
	CONSTRAINT "order_items_restaurant_id_id_unique" UNIQUE("restaurant_id","id"),
	CONSTRAINT "order_items_quantity" CHECK ("order_items"."quantity" between 1 and 20),
	CONSTRAINT "order_items_note" CHECK ("order_items"."note" is null or (trim("order_items"."note") <> '' and length("order_items"."note") <= 200)),
	CONSTRAINT "order_items_prices_not_negative" CHECK ("order_items"."unit_price_usd" >= 0 and "order_items"."unit_price_zig" >= 0),
	CONSTRAINT "order_items_prices_finite" CHECK ("order_items"."unit_price_usd" < 'Infinity' and "order_items"."unit_price_zig" < 'Infinity'),
	CONSTRAINT "order_items_zig_source" CHECK (("order_items"."unit_price_zig" is null) = ("order_items"."zig_source" is null)),
	CONSTRAINT "order_items_void_recorded" CHECK ("order_items"."status" <> 'voided' or ("order_items"."void_reason" is not null and "order_items"."voided_by" is not null))
);
--> statement-breakpoint
ALTER TABLE "order_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"customer_name" text NOT NULL,
	"rate_used" numeric,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_restaurant_id_id_unique" UNIQUE("restaurant_id","id"),
	CONSTRAINT "orders_customer_name" CHECK (trim("orders"."customer_name") <> '' and length("orders"."customer_name") <= 100),
	CONSTRAINT "orders_rate_used_positive" CHECK ("orders"."rate_used" > 0),
	CONSTRAINT "orders_rate_used_finite" CHECK ("orders"."rate_used" < 'Infinity')
);
--> statement-breakpoint
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "table_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"status" "table_session_status" DEFAULT 'open' NOT NULL,
	"approved_at" timestamp with time zone,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"waiter_requested_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"close_reason" "table_session_close_reason",
	"closed_by" uuid,
	"paid_currency" "paid_currency",
	CONSTRAINT "table_sessions_restaurant_id_id_unique" UNIQUE("restaurant_id","id")
);
--> statement-breakpoint
ALTER TABLE "table_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_fk" FOREIGN KEY ("restaurant_id","order_id") REFERENCES "public"."orders"("restaurant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_menu_item_fk" FOREIGN KEY ("restaurant_id","menu_item_id") REFERENCES "public"."menu_items"("restaurant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_special_fk" FOREIGN KEY ("restaurant_id","special_id") REFERENCES "public"."specials"("restaurant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_voided_by_fk" FOREIGN KEY ("restaurant_id","voided_by") REFERENCES "public"."staff"("restaurant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_session_fk" FOREIGN KEY ("restaurant_id","session_id") REFERENCES "public"."table_sessions"("restaurant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_table_fk" FOREIGN KEY ("restaurant_id","table_id") REFERENCES "public"."tables"("restaurant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_closed_by_fk" FOREIGN KEY ("restaurant_id","closed_by") REFERENCES "public"."staff"("restaurant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_items_restaurant_id_order_id_index" ON "order_items" USING btree ("restaurant_id","order_id");--> statement-breakpoint
CREATE INDEX "orders_restaurant_id_session_id_placed_at_index" ON "orders" USING btree ("restaurant_id","session_id","placed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "table_sessions_one_open_per_table" ON "table_sessions" USING btree ("table_id") WHERE "table_sessions"."status" = 'open';--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "order_items" AS PERMISSIVE FOR ALL TO public USING ("restaurant_id" = nullif(current_setting('app.restaurant_id', true), '')::uuid) WITH CHECK ("restaurant_id" = nullif(current_setting('app.restaurant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "orders" AS PERMISSIVE FOR ALL TO public USING ("restaurant_id" = nullif(current_setting('app.restaurant_id', true), '')::uuid) WITH CHECK ("restaurant_id" = nullif(current_setting('app.restaurant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "table_sessions" AS PERMISSIVE FOR ALL TO public USING ("restaurant_id" = nullif(current_setting('app.restaurant_id', true), '')::uuid) WITH CHECK ("restaurant_id" = nullif(current_setting('app.restaurant_id', true), '')::uuid);--> statement-breakpoint
-- Not in the Drizzle schema, which can't model triggers (see schema.ts,
-- tableSessions). Spec 00 › Enforced in the database: orders only go into an open
-- session, and a placed line's prices can't change.
--
-- Nothing customer-facing is hard-deleted (spec 00), and a void is a status, so
-- app_tenant gets no DELETE on these three (proposed). Same exception to 0002's
-- default privileges as 0003 and 0018.
REVOKE DELETE ON table_sessions, orders, order_items FROM app_tenant;
--> statement-breakpoint
-- ORDERS ONLY INTO AN OPEN SESSION. The foreign key's check takes KEY SHARE on the
-- session's row, and a close is an UPDATE of status, which takes NO KEY UPDATE:
-- the two don't conflict, so an order and a close could each pass, neither seeing
-- the other. FOR SHARE does conflict with it. So an order waits for a close in
-- flight and then reads the committed row (READ COMMITTED re-reads a locked row
-- once its lock is released), and a close waits for an order in flight, which
-- the closure gate (spec 00) then sees. AFTER, so RLS's WITH CHECK has already
-- refused a row forged for another restaurant, and SECURITY INVOKER, so it reads
-- only what the caller may see.
CREATE FUNCTION orders_session_open() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  session_status public.table_session_status;
BEGIN
  SELECT s.status INTO session_status
  FROM public.table_sessions s
  WHERE s.restaurant_id = NEW.restaurant_id AND s.id = NEW.session_id
  FOR SHARE;
  IF session_status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'an order can only go into an open session'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'orders_session_open';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION orders_session_open() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER orders_session_open
  AFTER INSERT ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_session_open();
--> statement-breakpoint
-- The same rule for a line: its order's session must still be open, under the
-- same lock, so a line can't be added to an order of a session that has closed.
CREATE FUNCTION order_items_session_open() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  session_status public.table_session_status;
BEGIN
  SELECT s.status INTO session_status
  FROM public.orders o
  JOIN public.table_sessions s
    ON s.restaurant_id = o.restaurant_id AND s.id = o.session_id
  WHERE o.restaurant_id = NEW.restaurant_id AND o.id = NEW.order_id
  FOR SHARE OF s;
  IF session_status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'a line can only go on an order of an open session'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'order_items_session_open';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION order_items_session_open() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER order_items_session_open
  AFTER INSERT ON order_items
  FOR EACH ROW EXECUTE FUNCTION order_items_session_open();
--> statement-breakpoint
-- FROZEN PRICES (spec 06). What a line was sold as, and at what price, never
-- changes once it is written, whoever asks: the owner role too. Its status, and
-- a void's reason and who voided it, still move. The constraint to name comes
-- from the trigger, so one function serves both tables.
CREATE FUNCTION refuse_frozen_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'a placed order''s prices can''t change'
    USING ERRCODE = 'check_violation', CONSTRAINT = TG_ARGV[0];
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION refuse_frozen_change() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER order_items_frozen
  BEFORE UPDATE ON order_items
  FOR EACH ROW WHEN (
    OLD.menu_item_id IS DISTINCT FROM NEW.menu_item_id
    OR OLD.special_id IS DISTINCT FROM NEW.special_id
    OR OLD.name_snapshot IS DISTINCT FROM NEW.name_snapshot
    OR OLD.quantity IS DISTINCT FROM NEW.quantity
    OR OLD.unit_price_usd IS DISTINCT FROM NEW.unit_price_usd
    OR OLD.unit_price_zig IS DISTINCT FROM NEW.unit_price_zig
    OR OLD.zig_source IS DISTINCT FROM NEW.zig_source
  )
  EXECUTE FUNCTION refuse_frozen_change('order_items_frozen');
--> statement-breakpoint
CREATE TRIGGER orders_rate_used_frozen
  BEFORE UPDATE ON orders
  FOR EACH ROW WHEN (OLD.rate_used IS DISTINCT FROM NEW.rate_used)
  EXECUTE FUNCTION refuse_frozen_change('orders_rate_used_frozen');
