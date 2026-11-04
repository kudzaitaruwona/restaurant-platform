-- /b/{manage_token} has no session, so the guest's manage token is the only way
-- to a tenant, the same as a menu token (S-31): an exact token in, a restaurant
-- id out, as the role that owns the tables, which RLS skips. It returns the id
-- and nothing else, so a token can't be used to read the booking, let alone
-- another. Only src/lib/tenant/public.ts calls it. Every further read and the
-- cancel itself run under RLS, through withTenant().
CREATE FUNCTION public.restaurant_id_by_manage_token(p_token text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT b.restaurant_id FROM public.bookings b WHERE b.manage_token = p_token
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.restaurant_id_by_manage_token(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.restaurant_id_by_manage_token(text) TO app_tenant;
