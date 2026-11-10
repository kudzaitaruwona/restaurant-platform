CREATE TYPE "public"."notification_channel" AS ENUM('whatsapp');--> statement-breakpoint
CREATE TYPE "public"."notification_kind" AS ENUM('booking_confirmed', 'booking_reminder', 'booking_cancelled');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('pending', 'sending', 'sent', 'delivered', 'read', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"kind" "notification_kind" NOT NULL,
	"channel" "notification_channel" DEFAULT 'whatsapp' NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"status" "notification_status" DEFAULT 'pending' NOT NULL,
	"claimed_at" timestamp with time zone,
	"provider_message_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_restaurant_id_id_unique" UNIQUE("restaurant_id","id"),
	CONSTRAINT "notifications_booking_id_kind_unique" UNIQUE("booking_id","kind"),
	CONSTRAINT "notifications_attempts_non_negative" CHECK ("notifications"."attempts" >= 0),
	CONSTRAINT "notifications_sending_claimed" CHECK ("notifications"."status" <> 'sending' or "notifications"."claimed_at" is not null),
	CONSTRAINT "notifications_last_error_length" CHECK (length("notifications"."last_error") <= 500)
);
--> statement-breakpoint
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_restaurant_id_booking_id_bookings_restaurant_id_id_fk" FOREIGN KEY ("restaurant_id","booking_id") REFERENCES "public"."bookings"("restaurant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_pending_scheduled_for_index" ON "notifications" USING btree ("scheduled_for") WHERE "notifications"."status" = 'pending';--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications" AS PERMISSIVE FOR ALL TO public USING ("restaurant_id" = nullif(current_setting('app.restaurant_id', true), '')::uuid) WITH CHECK ("restaurant_id" = nullif(current_setting('app.restaurant_id', true), '')::uuid);--> statement-breakpoint
-- The outbox (spec 05, issue 44). app_tenant writes a row in the same transaction
-- as the booking that owes it, through the default privileges 0002 gives it on
-- every table, under RLS like every other tenant table.
--
-- The scheduled job (app_system, BYPASSRLS) claims and sends them. It reads the
-- columns that pick a due row and claim it, and writes only what a send changes.
-- It can't insert a row or move one to another booking: it can only send what a
-- booking change queued.
GRANT SELECT (restaurant_id, id, kind, status, scheduled_for, attempts),
  UPDATE (status, claimed_at, attempts, last_error, provider_message_id)
  ON notifications TO app_system;
--> statement-breakpoint
-- To send, the job needs the guest's name, number and manage link, which 0033
-- took care it can't read for every booking. This view hands them over for a
-- notification it has claimed (status = 'sending') and for no other booking, so
-- the job reads what it is about to send and nothing else. It runs as its owner,
-- the migration role, which RLS skips; the join names restaurant_id on every
-- side, so a row can't pick up another tenant's booking. security_barrier keeps a
-- caller's own predicates from running before the view's filter.
CREATE VIEW notification_sends WITH (security_barrier) AS
  SELECT n.restaurant_id, n.id, n.kind,
    b.status AS booking_status, b.guest_name, b.guest_phone, b.whatsapp_opt_in,
    b.party_size, b.starts_at, b.manage_token,
    r.name AS restaurant_name, r.contact_phone AS restaurant_phone, r.timezone
  FROM public.notifications n
  JOIN public.bookings b ON b.restaurant_id = n.restaurant_id AND b.id = n.booking_id
  JOIN public.restaurants r ON r.id = n.restaurant_id
  WHERE n.status = 'sending';
--> statement-breakpoint
-- 0002's default privileges hand app_tenant SELECT on every new relation, views
-- included. A view runs as its owner, so RLS wouldn't hold app_tenant to one
-- tenant here: it gets nothing on it.
REVOKE ALL ON notification_sends FROM PUBLIC, app_tenant;
--> statement-breakpoint
GRANT SELECT ON notification_sends TO app_system;
