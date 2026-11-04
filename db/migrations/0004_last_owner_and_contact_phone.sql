ALTER TABLE "restaurants" ADD CONSTRAINT "restaurants_contact_phone_e164" CHECK ("restaurants"."contact_phone" ~ '^[+][1-9][0-9]{1,14}$');--> statement-breakpoint
-- S-26: every restaurant keeps at least one active owner. A row counts when it
-- is an active owner with kind = 'staff'; platform_admin shadow rows have
-- role = owner for permission checks but never count.
--
-- It only asks anything when a counted row stops counting, so a restaurant with
-- no owner yet is left alone: #14's first owner is a plain INSERT.
--
-- SECURITY DEFINER so the count sees the whole restaurant whatever the caller's
-- RLS context. Only the trigger can call it.
CREATE FUNCTION staff_keep_last_owner() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT (OLD.kind = 'staff' AND OLD.role = 'owner' AND OLD.active) THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE'
    AND NEW.kind = 'staff' AND NEW.role = 'owner' AND NEW.active
    AND NEW.restaurant_id = OLD.restaurant_id THEN
    RETURN NULL;
  END IF;

  -- Two transactions each removing one of two owners would otherwise each see
  -- the other still there. This no-op write queues them per restaurant, and the
  -- next statement's fresh READ COMMITTED snapshot sees what the first committed.
  -- A write rather than SELECT FOR UPDATE because REPEATABLE READ keeps its old
  -- snapshot: it has to fail here with a serialization error, and a plain row
  -- lock wouldn't make it. Touches no key column, so inserts into staff, whose
  -- foreign key only needs FOR KEY SHARE, don't wait on it.
  UPDATE restaurants SET name = name WHERE id = OLD.restaurant_id;

  IF NOT EXISTS (
    SELECT FROM staff
    WHERE restaurant_id = OLD.restaurant_id
      AND kind = 'staff' AND role = 'owner' AND active
  ) THEN
    RAISE EXCEPTION 'restaurant % must keep at least one active owner', OLD.restaurant_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'staff_last_active_owner';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION staff_keep_last_owner() FROM PUBLIC;
--> statement-breakpoint
-- AFTER, so it judges where the statement ended up: one UPDATE that hands
-- ownership from A to B passes, one that demotes everybody doesn't.
CREATE TRIGGER staff_keep_last_owner
  AFTER UPDATE OF role, active, kind, restaurant_id OR DELETE ON staff
  FOR EACH ROW EXECUTE FUNCTION staff_keep_last_owner();
