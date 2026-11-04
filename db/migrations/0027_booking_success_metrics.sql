-- Booking success metrics (spec 04): the numbers that win the next venues. One
-- definition, in Postgres, so the owner's dashboard and the platform admin's
-- console can't disagree: the owner's reads call booking_success_metrics() as
-- app_tenant, and platform_booking_metrics() calls the same function for every
-- restaurant.
--
-- What counts as a booking here: a walk-in (a staff row named 'Walk-in', spec 04
-- "Walk-in") is staff seating a party at the door, not a booking taken, so it is
-- in none of the numbers. Every other row counts whatever its status became, since
-- a booking that was later cancelled was still made.
--   * outside_hours: an online booking whose created_at, on the restaurant's
--     clock (restaurants.timezone, never the server's), is not inside any service
--     period of that weekday. A period holds [opens_at, closes_at), as the day
--     view does. Periods can't cross midnight in v1 (service_periods_same_day), so
--     the local weekday of created_at is the weekday to look up.
--   * attended / no_shows: bookings whose outcome is known and the guest was
--     expected: seated, completed or no_show. Cancelled and still-confirmed
--     bookings are neither.
-- Periods are today's, not the ones in force when the booking was made.

-- SECURITY INVOKER: under RLS for app_tenant, so another restaurant's id gives
-- zeros. The platform function below runs it as the table owner.
CREATE FUNCTION public.booking_success_metrics(p_restaurant_id uuid)
RETURNS TABLE (
  online integer,
  staff integer,
  outside_hours integer,
  no_shows integer,
  attended integer
)
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  WITH made AS (
    SELECT b.source, b.status, (b.created_at AT TIME ZONE r.timezone) AS local_at
    FROM public.bookings b
    JOIN public.restaurants r ON r.id = b.restaurant_id
    WHERE b.restaurant_id = p_restaurant_id
      AND NOT (b.source = 'staff' AND b.guest_name = 'Walk-in')
  )
  SELECT
    (count(*) FILTER (WHERE source = 'online'))::integer,
    (count(*) FILTER (WHERE source = 'staff'))::integer,
    (count(*) FILTER (
      WHERE source = 'online'
        AND NOT EXISTS (
          SELECT FROM public.service_periods p
          WHERE p.restaurant_id = p_restaurant_id
            AND p.weekday = extract(dow FROM local_at)::integer
            AND local_at::time >= p.opens_at
            AND local_at::time < p.closes_at
        )
    ))::integer,
    (count(*) FILTER (WHERE status = 'no_show'))::integer,
    (count(*) FILTER (WHERE status IN ('seated', 'completed', 'no_show')))::integer
  FROM made;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.booking_success_metrics(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.booking_success_metrics(uuid) TO app_tenant;
--> statement-breakpoint
-- The admin console's view: every restaurant, one statement. Only app_admin can
-- call it (S-28), and only through src/lib/tenant/platform-admin.ts.
CREATE FUNCTION public.platform_list_booking_metrics(p_admin_id uuid)
RETURNS TABLE (
  restaurant_id uuid,
  online integer,
  staff integer,
  outside_hours integer,
  no_shows integer,
  attended integer
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM public.platform_assert_admin(p_admin_id);

  RETURN QUERY
  SELECT r.id, m.online, m.staff, m.outside_hours, m.no_shows, m.attended
  FROM public.restaurants r
  CROSS JOIN LATERAL public.booking_success_metrics(r.id) m;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_list_booking_metrics(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_list_booking_metrics(uuid) TO app_admin;
