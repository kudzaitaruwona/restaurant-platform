-- A public route has no session, so its token is the only way to a tenant (spec
-- 01), and RLS rightly hides `restaurants` from app_tenant until one is set. This
-- is the one way past it: an exact token in, a restaurant id out, as the role
-- that owns the tables, which RLS skips.
--
-- It returns the id and nothing else, because the table also holds Wi-Fi
-- passwords. Everything after it runs under RLS as usual: the caller passes the
-- id to withTenant(). Only src/lib/tenant/public.ts calls it (S-31).
--
-- search_path is pinned with pg_temp last, so no object of the caller's can stand
-- in for the table, and the table is schema-qualified. A new kind of token gets
-- its own function of the same shape.
CREATE FUNCTION public.restaurant_id_by_menu_token(p_token text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT r.id FROM public.restaurants r WHERE r.menu_token = p_token
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.restaurant_id_by_menu_token(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.restaurant_id_by_menu_token(text) TO app_tenant;
