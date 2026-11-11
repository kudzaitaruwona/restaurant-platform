CREATE TABLE "staff_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered" boolean,
	CONSTRAINT "staff_invites_restaurant_id_id_unique" UNIQUE("restaurant_id","id")
);
--> statement-breakpoint
ALTER TABLE "staff_invites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN "first_signed_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "staff_invites" ADD CONSTRAINT "staff_invites_restaurant_id_staff_id_staff_restaurant_id_id_fk" FOREIGN KEY ("restaurant_id","staff_id") REFERENCES "public"."staff"("restaurant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "staff_invites_by_person" ON "staff_invites" USING btree ("restaurant_id","staff_id","sent_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "staff_invites" AS PERMISSIVE FOR ALL TO public USING ("restaurant_id" = nullif(current_setting('app.restaurant_id', true), '')::uuid) WITH CHECK ("restaurant_id" = nullif(current_setting('app.restaurant_id', true), '')::uuid);