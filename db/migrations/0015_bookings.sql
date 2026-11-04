CREATE TYPE "public"."booking_cancelled_by" AS ENUM('guest', 'staff');--> statement-breakpoint
CREATE TYPE "public"."booking_source" AS ENUM('online', 'staff');--> statement-breakpoint
CREATE TYPE "public"."booking_status" AS ENUM('confirmed', 'seated', 'completed', 'cancelled', 'no_show');--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"guest_name" text NOT NULL,
	"guest_phone" text,
	"whatsapp_opt_in" boolean NOT NULL,
	"party_size" integer NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"hold_ends_at" timestamp with time zone NOT NULL,
	"status" "booking_status" NOT NULL,
	"source" "booking_source" NOT NULL,
	"guest_note" text,
	"manage_token" text NOT NULL,
	"cancelled_by" "booking_cancelled_by",
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookings_manage_token_unique" UNIQUE("manage_token"),
	CONSTRAINT "bookings_restaurant_id_id_unique" UNIQUE("restaurant_id","id"),
	CONSTRAINT "bookings_guest_name" CHECK (trim("bookings"."guest_name") <> '' and length("bookings"."guest_name") <= 100),
	CONSTRAINT "bookings_guest_phone_e164" CHECK ("bookings"."guest_phone" ~ '^[+][1-9][0-9]{7,14}$'),
	CONSTRAINT "bookings_party_size_positive" CHECK ("bookings"."party_size" > 0),
	CONSTRAINT "bookings_guest_note_length" CHECK (length("bookings"."guest_note") <= 200),
	CONSTRAINT "bookings_times_ordered" CHECK ("bookings"."starts_at" < "bookings"."ends_at" and "bookings"."ends_at" <= "bookings"."hold_ends_at"),
	CONSTRAINT "bookings_manage_token_shape" CHECK ("bookings"."manage_token" ~ '^[0-9A-Za-z]{22,}$')
);
--> statement-breakpoint
ALTER TABLE "bookings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_restaurant_id_table_id_tables_restaurant_id_id_fk" FOREIGN KEY ("restaurant_id","table_id") REFERENCES "public"."tables"("restaurant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bookings_restaurant_id_starts_at_index" ON "bookings" USING btree ("restaurant_id","starts_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "bookings" AS PERMISSIVE FOR ALL TO public USING ("restaurant_id" = nullif(current_setting('app.restaurant_id', true), '')::uuid) WITH CHECK ("restaurant_id" = nullif(current_setting('app.restaurant_id', true), '')::uuid);--> statement-breakpoint
-- Not in the Drizzle schema, which can't model exclusion constraints (see
-- schema.ts, bookings). THE double-booking guard: no two live bookings hold one
-- table at the same moment, however many guests confirm at once (btree_gist,
-- migration 0000). The app's availability check only keeps the UI honest; this
-- is what prevents the double booking.
--
-- The range is half-open, so one hold may end at the instant the next starts.
-- `completed` stays in so that the reset buffer after an early finish still
-- counts; `cancelled` and `no_show` free the table. It runs whatever RLS shows
-- the caller, and a violation aborts the statement, so a confirm tries each
-- candidate table in a SAVEPOINT of its own (src/lib/bookings.ts).
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_no_overlap"
  EXCLUDE USING gist (
    "table_id" WITH =,
    tstzrange("starts_at", "hold_ends_at") WITH &&
  ) WHERE ("status" IN ('confirmed', 'seated', 'completed'));
--> statement-breakpoint
-- /r/{slug}/book has no session, so its slug is the only way to a tenant, the
-- same as a menu token (S-31): an exact slug in, a restaurant id out, as the role
-- that owns the tables, which RLS skips. It returns the id and nothing else,
-- because the table also holds Wi-Fi passwords. Only src/lib/tenant/public.ts
-- calls it.
CREATE FUNCTION public.restaurant_id_by_slug(p_slug text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT r.id FROM public.restaurants r WHERE r.slug = p_slug
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.restaurant_id_by_slug(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.restaurant_id_by_slug(text) TO app_tenant;
