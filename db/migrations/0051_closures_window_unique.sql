-- #108: the same closure can't be saved twice. "The same" is the same restaurant
-- and the same window; the reason is a note on it, not part of what it closes, so
-- two closures that differ only in their reason are one closure said twice.
--
-- Closures saved before this may already repeat. A repeat closes nothing the first
-- doesn't, and nothing refers to a closure, so the extras are deleted: the one
-- kept is the one with a reason (of several, the lowest id: ids are random, so that
-- is only so the choice doesn't depend on the order rows are read), else the lowest id. The closure guard
-- triggers fire on insert and on bookings, never on a delete, so this frees times
-- for no one: the kept row closes the same window.
DELETE FROM "closures" c
USING (
  SELECT "id",
         row_number() OVER (
           PARTITION BY "restaurant_id", "starts_at", "ends_at"
           ORDER BY ("reason" IS NULL), "id"
         ) AS n
  FROM "closures"
) d
WHERE c."id" = d."id" AND d.n > 1;--> statement-breakpoint
ALTER TABLE "closures" ADD CONSTRAINT "closures_window_unique" UNIQUE("restaurant_id","starts_at","ends_at");
