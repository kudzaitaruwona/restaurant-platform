-- The separate admin login S-28 said to add once the admin path could reach an
-- onboarded restaurant, which entering one does. Until now every request was
-- app_tenant, so Postgres couldn't tell an admin from a tenant: SQL run as
-- app_tenant could clear app.restaurant_id, call the platform_* functions and
-- plant a working magic link in admin_auth_verification. app_admin takes all of
-- that away from it. Only the admin seam connects as app_admin (DATABASE_URL_ADMIN,
-- src/db/admin.ts).
--
-- Like app_tenant it starts NOLOGIN with no password, so no secret lives here:
-- `npm run db:migrate` turns on LOGIN with the password from DATABASE_URL_ADMIN
-- and fails if RLS wouldn't apply to it (src/db/app-role.ts). The guard is
-- because roles are per cluster, not per database. On Neon it has to be created
-- with SQL like this: one made in the Console joins neon_superuser.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_admin') THEN
    CREATE ROLE app_admin NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_admin;
--> statement-breakpoint
-- Better Auth's admin audience now connects as app_admin. app_tenant keeps
-- nothing: 0002's default privileges gave it all of these, and they'll give it
-- the next one too, which src/db/admin-role.int.test.ts refuses.
REVOKE ALL ON
  admin_auth_user, admin_auth_session, admin_auth_account,
  admin_auth_verification, admin_auth_rate_limit, admin_auth_code_limit,
  admin_auth_entry
FROM app_tenant;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON
  admin_auth_user, admin_auth_session, admin_auth_account,
  admin_auth_verification, admin_auth_rate_limit, admin_auth_code_limit
TO app_admin;
--> statement-breakpoint
-- Read only: an entry is written by the functions below, which also audit it.
GRANT SELECT ON admin_auth_entry TO app_admin;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.platform_create_restaurant(uuid, text, text, text, public.currency_mode) FROM app_tenant;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_create_restaurant(uuid, text, text, text, public.currency_mode) TO app_admin;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.platform_create_first_owner(uuid, uuid, text, text) FROM app_tenant;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_create_first_owner(uuid, uuid, text, text) TO app_admin;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.platform_list_restaurants(uuid) FROM app_tenant;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_list_restaurants(uuid) TO app_admin;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.platform_admin_id_by_email(text) FROM app_tenant;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_admin_id_by_email(text) TO app_admin;
--> statement-breakpoint
-- Entering a restaurant (spec 01). One statement does all of it, so the shadow
-- row, the entry and the audit entry can't come apart. The first entry makes the
-- shadow row: ON CONFLICT on the unique index means a second first entry waits
-- for the first to commit, then does nothing and finds its row. Every entry is
-- audited, not just the first, and going straight from one restaurant to another
-- is also leaving the first, so that's written to the first's log. The row lock
-- makes two moves at once take turns, so each leaves where the other went.
--
-- search_path is pinned with pg_temp last and every object schema-qualified, as
-- in 0004.
CREATE FUNCTION public.platform_enter_restaurant(
  p_admin_id uuid,
  p_session_id text,
  p_restaurant_id uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_shadow_id uuid;
  v_previous_id uuid;
BEGIN
  PERFORM public.platform_assert_admin(p_admin_id);

  PERFORM FROM public.restaurants WHERE id = p_restaurant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such restaurant' USING ERRCODE = 'no_data_found';
  END IF;

  INSERT INTO public.staff (restaurant_id, kind, display_name, role)
  VALUES (p_restaurant_id, 'platform_admin', 'Platform admin', 'owner')
  ON CONFLICT (restaurant_id) WHERE kind = 'platform_admin' DO NOTHING;

  SELECT s.id INTO STRICT v_shadow_id
  FROM public.staff s
  WHERE s.restaurant_id = p_restaurant_id AND s.kind = 'platform_admin';

  SELECT e.entered_restaurant_id INTO v_previous_id
  FROM public.admin_auth_entry e
  WHERE e.session_id = p_session_id
  FOR UPDATE;

  IF v_previous_id <> p_restaurant_id THEN
    INSERT INTO public.audit_log
      (restaurant_id, actor_type, actor_id, action, entity_type, entity_id)
    VALUES (
      v_previous_id, 'platform_admin', p_admin_id, 'restaurant.leave',
      'restaurant', v_previous_id
    );
  END IF;

  INSERT INTO public.admin_auth_entry
    (session_id, entered_restaurant_id, shadow_staff_id)
  VALUES (p_session_id, p_restaurant_id, v_shadow_id)
  ON CONFLICT (session_id) DO UPDATE SET
    entered_restaurant_id = EXCLUDED.entered_restaurant_id,
    shadow_staff_id = EXCLUDED.shadow_staff_id,
    created_at = now();

  INSERT INTO public.audit_log
    (restaurant_id, actor_type, actor_id, action, entity_type, entity_id)
  VALUES (
    p_restaurant_id, 'platform_admin', p_admin_id, 'restaurant.enter',
    'restaurant', p_restaurant_id
  );

  RETURN v_shadow_id;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_enter_restaurant(uuid, text, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_enter_restaurant(uuid, text, uuid) TO app_admin;
--> statement-breakpoint
-- A session that wasn't in a restaurant has nothing to leave, and nothing to audit.
CREATE FUNCTION public.platform_leave_restaurant(
  p_admin_id uuid,
  p_session_id text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_restaurant_id uuid;
BEGIN
  PERFORM public.platform_assert_admin(p_admin_id);

  DELETE FROM public.admin_auth_entry
  WHERE session_id = p_session_id
  RETURNING entered_restaurant_id INTO v_restaurant_id;

  IF FOUND THEN
    INSERT INTO public.audit_log
      (restaurant_id, actor_type, actor_id, action, entity_type, entity_id)
    VALUES (
      v_restaurant_id, 'platform_admin', p_admin_id, 'restaurant.leave',
      'restaurant', v_restaurant_id
    );
  END IF;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_leave_restaurant(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_leave_restaurant(uuid, text) TO app_admin;
