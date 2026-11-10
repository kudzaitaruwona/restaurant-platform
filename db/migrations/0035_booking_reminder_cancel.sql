-- A booking that ends early takes its pending reminder with it (spec 05, issue 45):
-- cancelled by anyone, marked no-show, or completed. It is a trigger rather than
-- a line in each path because a reminder for a booking that's gone is worse than
-- none, and the paths are many: the guest's cancel, staff's Cancel, No-show and
-- Finish, and the scheduled job's own no-show and completion (app_system, which
-- has no grant to read notifications.booking_id and shouldn't). Whichever path
-- changes the status, in the same transaction, the reminder follows.
--
-- SECURITY DEFINER, owned by the migration role, so it can update the outbox for
-- the job's login as well as the tenant's. It touches one row at most: the
-- booking's own pending booking_reminder, named by (restaurant_id, booking_id),
-- so it can't reach another tenant's. search_path is pinned; nobody can call it
-- but the trigger. A reminder already claimed (sending) is left to the send-time
-- status check, which marks it cancelled without sending.
CREATE FUNCTION bookings_cancel_pending_reminder() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  UPDATE public.notifications
    SET status = 'cancelled'
    WHERE restaurant_id = NEW.restaurant_id
      AND booking_id = NEW.id
      AND kind = 'booking_reminder'
      AND status = 'pending';
  RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION bookings_cancel_pending_reminder() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER bookings_cancel_pending_reminder
  AFTER UPDATE OF status ON bookings
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('cancelled', 'no_show', 'completed'))
  EXECUTE FUNCTION bookings_cancel_pending_reminder();
