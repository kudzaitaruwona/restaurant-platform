CREATE TYPE "public"."menu_visibility" AS ENUM('regular', 'special_only');--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "visibility" "menu_visibility" DEFAULT 'regular' NOT NULL;