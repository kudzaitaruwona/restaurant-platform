-- The onboarding checklist (spec 01), admin only. Tenants get nothing on the
-- table, so an owner can neither read nor change it, and app_admin reaches it,
-- like the rest of the platform path, through functions alone (S-28).
REVOKE ALL ON onboarding_checklist FROM app_tenant;
--> statement-breakpoint
-- One row per restaurant. All but qr_codes_printed is derived from the
-- restaurant's own data, read here as the table owner because app_admin can see
-- no tenant table. "Live" means not archived. search_path is pinned with pg_temp
-- last and every object schema-qualified, as in 0004.
CREATE FUNCTION public.platform_onboarding_checklist(p_admin_id uuid)
RETURNS TABLE (
  restaurant_id uuid,
  menu_entered boolean,
  photos boolean,
  exchange_rate_set boolean,
  tables_added boolean,
  qr_codes_printed boolean,
  qr_codes_printed_at timestamptz,
  booking_hours_set boolean,
  booking_enabled boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM public.platform_assert_admin(p_admin_id);

  RETURN QUERY
  SELECT r.id,
         EXISTS (SELECT FROM public.menu_items m
                 WHERE m.restaurant_id = r.id AND m.archived_at IS NULL),
         EXISTS (SELECT FROM public.menu_items m
                 WHERE m.restaurant_id = r.id AND m.archived_at IS NULL
                   AND m.photo_key IS NOT NULL),
         EXISTS (SELECT FROM public.exchange_rates x WHERE x.restaurant_id = r.id),
         EXISTS (SELECT FROM public.tables t
                 WHERE t.restaurant_id = r.id AND t.archived_at IS NULL),
         c.restaurant_id IS NOT NULL,
         c.qr_codes_printed_at,
         EXISTS (SELECT FROM public.service_periods p WHERE p.restaurant_id = r.id),
         COALESCE(b.enabled, false)
  FROM public.restaurants r
  LEFT JOIN public.onboarding_checklist c ON c.restaurant_id = r.id
  LEFT JOIN public.booking_settings b ON b.restaurant_id = r.id
  ORDER BY r.created_at DESC, r.id;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_onboarding_checklist(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_onboarding_checklist(uuid) TO app_admin;
--> statement-breakpoint
-- Ticks or unticks "QR codes printed" and audits it, in one statement. Ticking an
-- already-ticked restaurant keeps the first tick's time and admin, and is not
-- audited again: nothing changed.
CREATE FUNCTION public.platform_set_qr_codes_printed(
  p_admin_id uuid,
  p_restaurant_id uuid,
  p_printed boolean
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_changed boolean;
BEGIN
  PERFORM public.platform_assert_admin(p_admin_id);

  -- The lock makes two ticks at once take turns.
  PERFORM FROM public.restaurants WHERE id = p_restaurant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such restaurant' USING ERRCODE = 'no_data_found';
  END IF;

  IF p_printed THEN
    INSERT INTO public.onboarding_checklist (restaurant_id, qr_codes_printed_by)
    VALUES (p_restaurant_id, p_admin_id)
    ON CONFLICT (restaurant_id) DO NOTHING;
  ELSE
    DELETE FROM public.onboarding_checklist WHERE restaurant_id = p_restaurant_id;
  END IF;
  GET DIAGNOSTICS v_changed = ROW_COUNT;

  IF v_changed THEN
    INSERT INTO public.audit_log
      (restaurant_id, actor_type, actor_id, action, entity_type, entity_id)
    VALUES (
      p_restaurant_id, 'platform_admin', p_admin_id,
      CASE WHEN p_printed THEN 'onboarding.qr_codes_printed'
           ELSE 'onboarding.qr_codes_unprinted' END,
      'restaurant', p_restaurant_id
    );
  END IF;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_set_qr_codes_printed(uuid, uuid, boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_set_qr_codes_printed(uuid, uuid, boolean) TO app_admin;
