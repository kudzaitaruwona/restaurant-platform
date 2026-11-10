CREATE INDEX "bookings_phone_starts_at_index" ON "bookings" USING btree ("starts_at") WHERE "bookings"."guest_phone" is not null;--> statement-breakpoint
-- D-06's purge, run by app_system. It nulls guest_phone, and its WHERE clause
-- (guest_phone is not null, so a repeat touches nothing) needs SELECT on the same
-- column: the one personal column the job may now read, and the only one it may
-- write. The booking date is the local date in restaurants.timezone, so it reads
-- that and the id to join on, and no other column of restaurants (which also
-- holds the Wi-Fi password and the contact number). No trigger on bookings fires
-- on a change to guest_phone alone: the per-phone limit (0024) is an AFTER INSERT
-- trigger, and the others (0023, 0026) watch table_id, status, starts_at, ends_at.
GRANT SELECT (guest_phone), UPDATE (guest_phone) ON bookings TO app_system;
--> statement-breakpoint
GRANT SELECT (id, timezone) ON restaurants TO app_system;
