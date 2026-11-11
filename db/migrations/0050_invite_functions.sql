-- INVITES (S-42). An invite is only an email saying someone has an account and
-- how to sign in; it makes no credential. What Postgres holds here:
--  - staff.first_signed_in_at, "joined", is written by staff sign-in's own login
--    through one function, and by nothing else that isn't the table's owner.
--  - At most 3 invite emails per person per hour, whichever path sends them.
--  - The platform admin's half (the first owner's invite, sending it again and
--    the owner card on /admin) through platform_* functions only (S-28).
--
-- search_path is pinned with pg_temp last and every object schema-qualified, as
-- in 0004.

-- Joined is set once, by staff_record_first_sign_in below. app_tenant has
-- UPDATE and INSERT on staff for staff management, and Drizzle names every
-- column in an insert, so a column grant can't keep it off this one: a trigger
-- does, for anyone but the table's owner (migrations, the seed, and the
-- SECURITY DEFINER functions, which run as it).
CREATE FUNCTION public.staff_first_sign_in_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.first_signed_in_at IS NOT NULL)
     OR (TG_OP = 'UPDATE' AND NEW.first_signed_in_at IS DISTINCT FROM OLD.first_signed_in_at)
  THEN
    IF NOT pg_catalog.pg_has_role(
      current_user,
      (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.staff'::regclass),
      'MEMBER'
    ) THEN
      RAISE EXCEPTION 'only staff sign-in records when someone joined'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.staff_first_sign_in_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER staff_first_sign_in_guard
BEFORE INSERT OR UPDATE OF first_signed_in_at ON public.staff
FOR EACH ROW EXECUTE FUNCTION public.staff_first_sign_in_guard();
--> statement-breakpoint
-- Everyone who has signed in before now has a staff_auth_user row, made on
-- their first sign-in. Shadow rows have no email, so never match.
UPDATE public.staff s
SET first_signed_in_at = u.created_at
FROM public.staff_auth_user u
WHERE u.email = lower(s.email) AND s.kind = 'staff';
--> statement-breakpoint
-- Called by staff sign-in after each new session (src/lib/auth). Only the first
-- counts. Deactivated staff and shadow rows can't sign in, so are left alone.
CREATE FUNCTION public.staff_record_first_sign_in(p_email text) RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  UPDATE public.staff
  SET first_signed_in_at = now()
  WHERE lower(email) = lower(p_email)
    AND kind = 'staff'
    AND active
    AND first_signed_in_at IS NULL
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.staff_record_first_sign_in(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.staff_record_first_sign_in(text) TO app_staff_auth;
--> statement-breakpoint
-- app_tenant records each invite and whether it went, and nothing else: no
-- deleting or backdating its way round the limit below.
REVOKE UPDATE, DELETE ON public.staff_invites FROM app_tenant;
--> statement-breakpoint
GRANT UPDATE (delivered) ON public.staff_invites TO app_tenant;
--> statement-breakpoint
-- The limit, on every path: the person's row is locked first, so two sends at
-- once take turns and the count holds. An invite is always stamped now.
CREATE FUNCTION public.staff_invites_limit() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW.sent_at := now();

  PERFORM FROM public.staff
  WHERE restaurant_id = NEW.restaurant_id AND id = NEW.staff_id
  FOR NO KEY UPDATE;

  IF (
    SELECT count(*) FROM public.staff_invites
    WHERE restaurant_id = NEW.restaurant_id
      AND staff_id = NEW.staff_id
      AND sent_at > now() - interval '1 hour'
  ) >= 3 THEN
    RAISE EXCEPTION 'at most 3 invites per person per hour' USING ERRCODE = 'PA002';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.staff_invites_limit() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER staff_invites_limit
BEFORE INSERT ON public.staff_invites
FOR EACH ROW EXECUTE FUNCTION public.staff_invites_limit();
--> statement-breakpoint
-- Records an invite to an active owner who hasn't joined, before it's sent, and
-- hands back what the email needs. p_resend audits it as "Send invite again";
-- the first invite goes with staff.create, already audited. The send itself
-- happens in the app, and platform_finish_invite records how it went.
CREATE FUNCTION public.platform_start_owner_invite(
  p_admin_id uuid,
  p_restaurant_id uuid,
  p_staff_id uuid,
  p_resend boolean
) RETURNS TABLE (invite_id uuid, email text, display_name text, restaurant_name text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_joined timestamptz;
BEGIN
  PERFORM public.platform_assert_admin(p_admin_id);

  SELECT s.email, s.display_name, r.name, s.first_signed_in_at
  INTO email, display_name, restaurant_name, v_joined
  FROM public.staff s
  JOIN public.restaurants r ON r.id = s.restaurant_id
  WHERE s.restaurant_id = p_restaurant_id
    AND s.id = p_staff_id
    AND s.kind = 'staff'
    AND s.role = 'owner'
    AND s.active
  FOR NO KEY UPDATE OF s;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such owner' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_joined IS NOT NULL THEN
    RAISE EXCEPTION 'already signed in' USING ERRCODE = 'PA003';
  END IF;

  INSERT INTO public.staff_invites (restaurant_id, staff_id)
  VALUES (p_restaurant_id, p_staff_id)
  RETURNING id INTO invite_id;

  IF p_resend THEN
    INSERT INTO public.audit_log
      (restaurant_id, actor_type, actor_id, action, entity_type, entity_id)
    VALUES
      (p_restaurant_id, 'platform_admin', p_admin_id, 'staff.invite_resend', 'staff', p_staff_id);
  END IF;

  RETURN NEXT;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_start_owner_invite(uuid, uuid, uuid, boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_start_owner_invite(uuid, uuid, uuid, boolean) TO app_admin;
--> statement-breakpoint
-- Whether the provider took it. Only once: a recorded outcome stays.
CREATE FUNCTION public.platform_finish_invite(
  p_admin_id uuid,
  p_restaurant_id uuid,
  p_invite_id uuid,
  p_delivered boolean
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM public.platform_assert_admin(p_admin_id);

  UPDATE public.staff_invites
  SET delivered = p_delivered
  WHERE restaurant_id = p_restaurant_id AND id = p_invite_id AND delivered IS NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_finish_invite(uuid, uuid, uuid, boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_finish_invite(uuid, uuid, uuid, boolean) TO app_admin;
--> statement-breakpoint
-- Every restaurant's active owners for the owner card on /admin: who, whether
-- they've joined, and their latest invite. Read as the table owner, because
-- app_admin can see no tenant table.
CREATE FUNCTION public.platform_list_owners(p_admin_id uuid)
RETURNS TABLE (
  restaurant_id uuid,
  staff_id uuid,
  display_name text,
  email text,
  first_signed_in_at timestamptz,
  invited_at timestamptz,
  invite_delivered boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM public.platform_assert_admin(p_admin_id);

  RETURN QUERY
  SELECT s.restaurant_id, s.id, s.display_name, s.email, s.first_signed_in_at,
         i.sent_at, i.delivered
  FROM public.staff s
  LEFT JOIN LATERAL (
    SELECT si.sent_at, si.delivered FROM public.staff_invites si
    WHERE si.restaurant_id = s.restaurant_id AND si.staff_id = s.id
    ORDER BY si.sent_at DESC
    LIMIT 1
  ) i ON true
  WHERE s.kind = 'staff' AND s.role = 'owner' AND s.active
  ORDER BY s.restaurant_id, s.created_at, s.id;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_list_owners(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_list_owners(uuid) TO app_admin;
