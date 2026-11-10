-- THE KITCHEN BOARD'S LOAD (proposed, S-40). The board finds the lines still in
-- play (placed, cooking, done) among every line the restaurant ever sold. As
-- app_tenant, under RLS, Postgres won't use a column's statistics through an
-- operator that isn't leakproof, and the enum's comparisons aren't: a filter on
-- status was estimated as most of the restaurant's lines, so the load
-- hash-joined every order the restaurant ever took. A stored boolean's equality
-- is leakproof, so a filter on in_play is estimated from its statistics. The
-- board reads the ids of the lines in play on it first, then those lines with
-- their orders by id (src/lib/kitchen.ts; src/lib/kitchen.int.test.ts measures
-- it). The index moves onto it.
DROP INDEX "order_items_in_play";--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "in_play" boolean GENERATED ALWAYS AS (status not in ('delivered', 'voided')) STORED NOT NULL;--> statement-breakpoint
CREATE INDEX "order_items_in_play" ON "order_items" USING btree ("restaurant_id") WHERE "order_items"."in_play";