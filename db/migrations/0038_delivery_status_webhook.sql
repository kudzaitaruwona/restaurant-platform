CREATE INDEX "notifications_provider_message_id_index" ON "notifications" USING btree ("provider_message_id") WHERE "notifications"."provider_message_id" is not null;--> statement-breakpoint
-- Meta's delivery-status webhook (spec 05, issue 48) runs as app_system, like the
-- scheduled job. It finds a notification by the message id its send got back,
-- then writes status and last_error keyed by (restaurant_id, id), which 0034
-- already lets it update. Reading provider_message_id is the one thing it adds.
GRANT SELECT (provider_message_id) ON notifications TO app_system;
