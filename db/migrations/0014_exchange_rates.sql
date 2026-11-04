CREATE TABLE "exchange_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"usd_to_zig" numeric NOT NULL,
	"set_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exchange_rates_restaurant_id_id_unique" UNIQUE("restaurant_id","id"),
	CONSTRAINT "exchange_rates_usd_to_zig_finite" CHECK ("exchange_rates"."usd_to_zig" > 0 and "exchange_rates"."usd_to_zig" < 'Infinity')
);
--> statement-breakpoint
ALTER TABLE "exchange_rates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_set_by_fk" FOREIGN KEY ("restaurant_id","set_by") REFERENCES "public"."staff"("restaurant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exchange_rates_restaurant_id_created_at_index" ON "exchange_rates" USING btree ("restaurant_id","created_at");--> statement-breakpoint
ALTER TABLE "restaurants" ADD CONSTRAINT "restaurants_rounding_steps_positive_finite" CHECK ("restaurants"."zig_rounding_step" > 0 and "restaurants"."zig_rounding_step" < 'Infinity' and "restaurants"."usd_rounding_step" > 0 and "restaurants"."usd_rounding_step" < 'Infinity');--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "exchange_rates" AS PERMISSIVE FOR ALL TO public USING ("restaurant_id" = nullif(current_setting('app.restaurant_id', true), '')::uuid) WITH CHECK ("restaurant_id" = nullif(current_setting('app.restaurant_id', true), '')::uuid);