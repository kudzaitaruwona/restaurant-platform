-- booking_cancelled's {{5}} depends on who cancelled (spec 05): the guest gets
-- "We hope to see you another time.", and a guest staff cancelled gets the
-- restaurant's contact line. The job reads the booking only through
-- notification_sends (0034), so the view carries cancelled_by, appended last, as
-- CREATE OR REPLACE VIEW requires. Which bookings it shows, and the grants on it
-- (app_system only), are unchanged.
CREATE OR REPLACE VIEW notification_sends WITH (security_barrier) AS
  SELECT n.restaurant_id, n.id, n.kind,
    b.status AS booking_status, b.guest_name, b.guest_phone, b.whatsapp_opt_in,
    b.party_size, b.starts_at, b.manage_token,
    r.name AS restaurant_name, r.contact_phone AS restaurant_phone, r.timezone,
    b.cancelled_by
  FROM public.notifications n
  JOIN public.bookings b ON b.restaurant_id = n.restaurant_id AND b.id = n.booking_id
  JOIN public.restaurants r ON r.id = n.restaurant_id
  WHERE n.status = 'sending';
