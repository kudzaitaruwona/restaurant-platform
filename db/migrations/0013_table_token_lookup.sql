-- A table's QR code reaches the menu with no session, so its token is the only
-- way to a tenant, the same as the menu token (S-31): an exact token in, a
-- restaurant id out, as the role that owns the tables, which RLS skips. Nothing
-- else about the table leaves it, so a printed code can't be used to read one.
--
-- An archived table's code resolves to nothing: the "out of date" page, same as
-- a regenerated one (spec 03 › Token rules).
CREATE FUNCTION public.restaurant_id_by_table_token(p_token text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT t.restaurant_id FROM public.tables t
  WHERE t.qr_token = p_token AND t.archived_at IS NULL
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.restaurant_id_by_table_token(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.restaurant_id_by_table_token(text) TO app_tenant;
