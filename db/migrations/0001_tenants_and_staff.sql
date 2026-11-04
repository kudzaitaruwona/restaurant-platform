CREATE TYPE "public"."currency_mode" AS ENUM('usd_only', 'zig_only', 'usd_primary', 'zig_primary', 'both');--> statement-breakpoint
CREATE TYPE "public"."staff_kind" AS ENUM('staff', 'platform_admin');--> statement-breakpoint
CREATE TYPE "public"."staff_role" AS ENUM('owner', 'staff');--> statement-breakpoint
CREATE TABLE "restaurants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"menu_token" text NOT NULL,
	"timezone" text DEFAULT 'Africa/Harare' NOT NULL,
	"contact_phone" text,
	"currency_mode" "currency_mode" NOT NULL,
	"zig_rounding_step" numeric DEFAULT '10' NOT NULL,
	"usd_rounding_step" numeric DEFAULT '0.01' NOT NULL,
	"wifi_name" text,
	"wifi_password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "restaurants_slug_unique" UNIQUE("slug"),
	CONSTRAINT "restaurants_menu_token_unique" UNIQUE("menu_token")
);
--> statement-breakpoint
ALTER TABLE "restaurants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "staff" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"kind" "staff_kind" DEFAULT 'staff' NOT NULL,
	"email" text,
	"display_name" text NOT NULL,
	"role" "staff_role" DEFAULT 'staff' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_email_unique" UNIQUE("email"),
	CONSTRAINT "staff_restaurant_id_id_unique" UNIQUE("restaurant_id","id"),
	CONSTRAINT "staff_email_required" CHECK ("staff"."kind" = 'platform_admin' or "staff"."email" is not null)
);
--> statement-breakpoint
ALTER TABLE "staff" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "restaurants" AS PERMISSIVE FOR ALL TO public USING ("id" = nullif(current_setting('app.restaurant_id', true), '')::uuid) WITH CHECK ("id" = nullif(current_setting('app.restaurant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "staff" AS PERMISSIVE FOR ALL TO public USING ("restaurant_id" = nullif(current_setting('app.restaurant_id', true), '')::uuid) WITH CHECK ("restaurant_id" = nullif(current_setting('app.restaurant_id', true), '')::uuid);