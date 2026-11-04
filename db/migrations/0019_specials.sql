CREATE TABLE "specials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"title" text,
	"special_price_usd" numeric,
	"special_price_zig" numeric,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"days_of_week" integer[],
	"daily_start" time,
	"daily_end" time,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "specials_restaurant_id_id_unique" UNIQUE("restaurant_id","id"),
	CONSTRAINT "specials_prices_not_negative" CHECK ("specials"."special_price_usd" >= 0 and "specials"."special_price_zig" >= 0),
	CONSTRAINT "specials_prices_finite" CHECK ("specials"."special_price_usd" < 'Infinity' and "specials"."special_price_zig" < 'Infinity'),
	CONSTRAINT "specials_does_something" CHECK ("specials"."title" is not null or "specials"."special_price_usd" is not null or "specials"."special_price_zig" is not null),
	CONSTRAINT "specials_window_ordered" CHECK ("specials"."starts_at" is null or "specials"."ends_at" is null or "specials"."ends_at" > "specials"."starts_at")
);
--> statement-breakpoint
ALTER TABLE "specials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "specials" ADD CONSTRAINT "specials_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specials" ADD CONSTRAINT "specials_menu_item_fk" FOREIGN KEY ("restaurant_id","menu_item_id") REFERENCES "public"."menu_items"("restaurant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "specials_restaurant_id_menu_item_id_index" ON "specials" USING btree ("restaurant_id","menu_item_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "specials" AS PERMISSIVE FOR ALL TO public USING ("restaurant_id" = nullif(current_setting('app.restaurant_id', true), '')::uuid) WITH CHECK ("restaurant_id" = nullif(current_setting('app.restaurant_id', true), '')::uuid);--> statement-breakpoint
-- D-05 (proposed): no two active specials on one item may overlap. Drizzle can't
-- model an exclusion constraint, so it is written here and nowhere else.
--  * btree_gist (0000) is what lets a GiST index mix `=` on uuid with `&&` on a
--    range. Neon ships the extension.
--  * restaurant_id leads, like every tenant key, so the rule is per restaurant.
--  * tstzrange(starts_at, ends_at) is half-open, [starts_at, ends_at). A null
--    bound is unbounded, which is exactly what spec 00 means: no start has no
--    lower end, and no end runs until turned off. Specials that meet at an
--    instant (one ends where the next begins) do not overlap.
--  * WHERE active: a special that is turned off holds no time. Turning it on
--    again is an UPDATE, which the constraint re-checks.
ALTER TABLE "specials" ADD CONSTRAINT "specials_no_overlap" EXCLUDE USING gist (
  "restaurant_id" WITH =,
  "menu_item_id" WITH =,
  tstzrange("starts_at", "ends_at") WITH &&
) WHERE ("active");
