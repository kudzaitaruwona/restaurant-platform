CREATE TABLE "tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"label" text NOT NULL,
	"capacity" integer NOT NULL,
	"bookable" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"qr_token" text NOT NULL,
	"token_rotated_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	CONSTRAINT "tables_qr_token_unique" UNIQUE("qr_token"),
	CONSTRAINT "tables_restaurant_id_id_unique" UNIQUE("restaurant_id","id"),
	CONSTRAINT "tables_capacity_positive" CHECK ("tables"."capacity" > 0),
	CONSTRAINT "tables_qr_token_shape" CHECK ("tables"."qr_token" ~ '^[0-9A-Za-z]{22,}$')
);
--> statement-breakpoint
ALTER TABLE "tables" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tables" ADD CONSTRAINT "tables_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tables_restaurant_id_label_unique" ON "tables" USING btree ("restaurant_id","label") WHERE "tables"."archived_at" is null;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tables" AS PERMISSIVE FOR ALL TO public USING ("restaurant_id" = nullif(current_setting('app.restaurant_id', true), '')::uuid) WITH CHECK ("restaurant_id" = nullif(current_setting('app.restaurant_id', true), '')::uuid);