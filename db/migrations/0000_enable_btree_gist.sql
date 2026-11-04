-- btree_gist lets a GiST exclusion constraint mix equality on scalar columns
-- (restaurant_id, table_id) with range overlap, as the booking and
-- service-period exclusion constraints do (spec 00). Neon supports it.
CREATE EXTENSION IF NOT EXISTS btree_gist;
