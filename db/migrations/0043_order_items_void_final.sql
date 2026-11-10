-- A VOID'S RECORD (spec 00, #73). A voided line says who voided it and why; the
-- reason is non-blank and at most 200 characters (proposed, like a note).
ALTER TABLE "order_items" DROP CONSTRAINT "order_items_void_recorded";--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_void_recorded" CHECK ("order_items"."status" <> 'voided' or ("order_items"."void_reason" is not null and trim("order_items"."void_reason") <> '' and length("order_items"."void_reason") <= 200 and "order_items"."voided_by" is not null));--> statement-breakpoint
-- A VOID IS FINAL (proposed, #73). A void takes a line off the bill, so whoever
-- asks, the owner role too: a voided line can't go back into play or to
-- delivered, and keeps its first reason and the staff member who voided it (a
-- reject leaves an earlier void's reason). A delivered line was carried to a
-- real table and eaten, so it can't be voided (S-36: a reject voids undelivered
-- items only; force-close voids only outstanding ones). The app refuses both
-- first, with a 409; this holds them for every writer.
CREATE FUNCTION refuse_void_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'a voided line stays voided with its first reason, and a delivered line can''t be voided'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'order_items_void_final';
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION refuse_void_change() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER order_items_void_final
  BEFORE UPDATE ON order_items
  FOR EACH ROW WHEN (
    (
      OLD.status = 'voided'
      AND (
        NEW.status IS DISTINCT FROM OLD.status
        OR NEW.void_reason IS DISTINCT FROM OLD.void_reason
        OR NEW.voided_by IS DISTINCT FROM OLD.voided_by
      )
    )
    OR (OLD.status = 'delivered' AND NEW.status = 'voided')
  )
  EXECUTE FUNCTION refuse_void_change();
