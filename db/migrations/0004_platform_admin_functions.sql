-- The platform admin's privileged path (S-28). app_tenant can't insert a
-- restaurant, and outside a tenant it can't see one or write audit_log. These
-- functions do exactly those jobs and nothing else, as the role that owns the
-- tables, which RLS skips. DATABASE_URL_SYSTEM stays out of it: spec 01 keeps
-- that for the scheduled job and the Meta webhook.
--
-- Postgres can't tell who is asking, because every request is app_tenant. So
-- what stops a tenant identity here is, in order:
--   1. getPlatformAdminContext() in front of every admin route, and these
--      functions are only called from src/lib/tenant/platform-admin.ts.
--   2. platform_assert_admin() refuses any caller with app.restaurant_id set.
--      All tenant code runs inside withTenant(), so a bug or a stray call there
--      can't get through, whatever id it passes.
--   3. platform_assert_admin() needs a real platform_admins id. That is
--      attribution, not authentication: audit_log shows the id to the tenant.
--   4. The damage is bounded even if 1-3 all fail. There is no way to touch an
--      onboarded restaurant: the first-owner function refuses any restaurant
--      that already has staff.
-- Code that can run arbitrary SQL as app_tenant gets past 2 and 3 with
-- set_config, as it already gets past RLS. It gains junk restaurants, the list
-- below and the first owner of a restaurant with no staff yet, each write
-- audited. Only a separate login role would stop it.
--
-- search_path is pinned with pg_temp last, so no object of the caller's can
-- stand in for one of these, and every object is schema-qualified.

-- Not SECURITY DEFINER and not granted to anyone: only the functions below,
-- which run as its owner, can call it.
CREATE FUNCTION public.platform_assert_admin(p_admin_id uuid) RETURNS void
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF nullif(current_setting('app.restaurant_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'platform functions cannot run inside a tenant'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT FROM public.platform_admins WHERE id = p_admin_id) THEN
    RAISE EXCEPTION 'not a platform admin'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_assert_admin(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.platform_create_restaurant(
  p_admin_id uuid,
  p_name text,
  p_slug text,
  p_timezone text,
  p_currency_mode public.currency_mode
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  PERFORM public.platform_assert_admin(p_admin_id);

  -- The app checks the name works in JavaScript; this that it works in queries.
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_timezone_names WHERE name = p_timezone) THEN
    RAISE EXCEPTION 'unknown timezone' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO public.restaurants (name, slug, menu_token, timezone, currency_mode)
  VALUES (
    p_name,
    p_slug,
    replace(gen_random_uuid()::text, '-', ''),
    p_timezone,
    p_currency_mode
  )
  RETURNING id INTO v_id;

  INSERT INTO public.audit_log
    (restaurant_id, actor_type, actor_id, action, entity_type, entity_id)
  VALUES
    (v_id, 'platform_admin', p_admin_id, 'restaurant.create', 'restaurant', v_id);

  RETURN v_id;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_create_restaurant(uuid, text, text, text, public.currency_mode) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_create_restaurant(uuid, text, text, text, public.currency_mode) TO app_tenant;
--> statement-breakpoint
CREATE FUNCTION public.platform_create_first_owner(
  p_admin_id uuid,
  p_restaurant_id uuid,
  p_email text,
  p_display_name text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  PERFORM public.platform_assert_admin(p_admin_id);

  -- The lock makes two submissions at once take turns, so the check below holds.
  PERFORM FROM public.restaurants WHERE id = p_restaurant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such restaurant' USING ERRCODE = 'no_data_found';
  END IF;

  -- Shadow rows (kind = platform_admin) aren't staff: entering a restaurant
  -- before it has an owner mustn't stop it getting one.
  IF EXISTS (
    SELECT FROM public.staff
    WHERE restaurant_id = p_restaurant_id AND kind = 'staff'
  ) THEN
    RAISE EXCEPTION 'restaurant already has staff' USING ERRCODE = 'PA001';
  END IF;

  INSERT INTO public.staff (restaurant_id, email, display_name, role)
  VALUES (p_restaurant_id, p_email, p_display_name, 'owner')
  RETURNING id INTO v_id;

  INSERT INTO public.audit_log
    (restaurant_id, actor_type, actor_id, action, entity_type, entity_id, details)
  VALUES (
    p_restaurant_id, 'platform_admin', p_admin_id, 'staff.create', 'staff', v_id,
    '{"role": "owner"}'
  );

  RETURN v_id;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_create_first_owner(uuid, uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_create_first_owner(uuid, uuid, text, text) TO app_tenant;
--> statement-breakpoint
-- Only what the admin screen shows: the table also holds Wi-Fi passwords.
CREATE FUNCTION public.platform_list_restaurants(p_admin_id uuid)
RETURNS TABLE (
  id uuid,
  name text,
  slug text,
  timezone text,
  currency_mode public.currency_mode,
  has_owner boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM public.platform_assert_admin(p_admin_id);

  RETURN QUERY
  SELECT r.id, r.name, r.slug, r.timezone, r.currency_mode,
         EXISTS (
           SELECT FROM public.staff s
           WHERE s.restaurant_id = r.id AND s.kind = 'staff' AND s.role = 'owner'
         )
  FROM public.restaurants r
  ORDER BY r.created_at DESC, r.id;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_list_restaurants(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_list_restaurants(uuid) TO app_tenant;
