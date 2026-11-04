CREATE TABLE "onboarding_checklist" (
	"restaurant_id" uuid PRIMARY KEY NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"qr_codes_printed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"qr_codes_printed_by" uuid NOT NULL,
	CONSTRAINT "onboarding_checklist_restaurant_id_id_unique" UNIQUE("restaurant_id","id")
);
--> statement-breakpoint
ALTER TABLE "onboarding_checklist" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "onboarding_checklist" ADD CONSTRAINT "onboarding_checklist_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "onboarding_checklist" AS PERMISSIVE FOR ALL TO public USING ("restaurant_id" = nullif(current_setting('app.restaurant_id', true), '')::uuid) WITH CHECK ("restaurant_id" = nullif(current_setting('app.restaurant_id', true), '')::uuid);