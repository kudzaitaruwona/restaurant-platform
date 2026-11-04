CREATE TABLE "admin_auth_code_limit" (
	"email" text PRIMARY KEY NOT NULL,
	"attempts" integer NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_auth_code_limit" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "staff_auth_code_limit" (
	"email" text PRIMARY KEY NOT NULL,
	"attempts" integer NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "staff_auth_code_limit" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "outside_tenant_only" ON "admin_auth_code_limit" AS PERMISSIVE FOR ALL TO public USING (nullif(current_setting('app.restaurant_id', true), '') is null) WITH CHECK (nullif(current_setting('app.restaurant_id', true), '') is null);--> statement-breakpoint
CREATE POLICY "outside_tenant_only" ON "staff_auth_code_limit" AS PERMISSIVE FOR ALL TO public USING (nullif(current_setting('app.restaurant_id', true), '') is null) WITH CHECK (nullif(current_setting('app.restaurant_id', true), '') is null);