-- Nothing has ever made a shadow row outside a test fixture, but long-lived test
-- databases are full of them, and the rules below refuse the ones that were
-- deactivated. Nothing refers to them.
DELETE FROM "staff" WHERE "kind" = 'platform_admin';--> statement-breakpoint
CREATE TABLE "admin_auth_entry" (
	"session_id" text PRIMARY KEY NOT NULL,
	"entered_restaurant_id" uuid NOT NULL,
	"shadow_staff_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_auth_entry" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "admin_auth_entry" ADD CONSTRAINT "admin_auth_entry_session_id_admin_auth_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."admin_auth_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_auth_entry" ADD CONSTRAINT "admin_auth_entry_entered_restaurant_id_shadow_staff_id_staff_restaurant_id_id_fk" FOREIGN KEY ("entered_restaurant_id","shadow_staff_id") REFERENCES "public"."staff"("restaurant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_one_shadow_per_restaurant" ON "staff" USING btree ("restaurant_id") WHERE "staff"."kind" = 'platform_admin';--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_shadow_row" CHECK ("staff"."kind" = 'staff' or ("staff"."email" is null and "staff"."role" = 'owner' and "staff"."active"));--> statement-breakpoint
CREATE POLICY "outside_tenant_only" ON "admin_auth_entry" AS PERMISSIVE FOR ALL TO public USING (nullif(current_setting('app.restaurant_id', true), '') is null) WITH CHECK (nullif(current_setting('app.restaurant_id', true), '') is null);