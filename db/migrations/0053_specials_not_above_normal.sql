-- A special is never above its item's normal price (S-45, #112, #129). Drizzle
-- can't model functions or triggers, so they are written here and nowhere else.
--
-- The rule is held on every write that can break it: a special added, turned on or
-- changed; an item's prices; a new exchange rate; the restaurant's currency_mode
-- and rounding steps. It looks at specials that are on and not over, of items not
-- archived: one that is off or over sells nothing, and turning it on asks again.
-- Turning a special off is never refused, so it is always the way out.
--
-- Rows from before this migration are left as they are. One already above its
-- normal price is named by the next change of its item's prices, the rate, the mode
-- or a step, and stops that until it is turned off.

-- ceil(value * factor / divisor / step) * step, exact, as "@/lib/pricing" does it.
-- div() and mod() are exact on numeric where `/` rounds its digits, and a rounded
-- quotient could be a step out. Null when there is nothing to work it out from.
CREATE FUNCTION price_rounded_up(value numeric, factor numeric, divisor numeric, step numeric)
RETURNS numeric
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp
AS $$
  SELECT (div(value * factor, divisor * step) + (mod(value * factor, divisor * step) > 0)::int) * step
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION price_rounded_up(numeric, numeric, numeric, numeric) FROM PUBLIC;
--> statement-breakpoint
-- The rule: no row when the special is fine, else the first currency in which it is
-- above, with both prices. Spec 02, "Prices that get a second look", in words:
--  * Only the currencies the menu shows under currency_mode are compared; a
--    single-currency mode shows the other one when its own can't be worked out.
--  * A typed price is compared in its own currency. The price calculated from it in
--    the other is compared only when the item fixes both its prices: on an item that
--    fixes one, both normal prices come from that one at the same rate, so the
--    calculated side is above only by rounding unless the typed one is above too.
--  * For the same reason one price typed on such an item is compared whatever the
--    mode, because the price shown is worked out from it.
CREATE FUNCTION special_above_normal(
  item_usd numeric, item_zig numeric, typed_usd numeric, typed_zig numeric,
  rate numeric, usd_step numeric, zig_step numeric, mode public.currency_mode,
  OUT currency text, OUT special numeric, OUT normal numeric, OUT calculated boolean
)
RETURNS SETOF record
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp
AS $$
  WITH normals AS (
    SELECT coalesce(item_usd, public.price_rounded_up(item_zig, 1, rate, usd_step)) AS usd,
           coalesce(item_zig, public.price_rounded_up(item_usd, rate, 1, zig_step)) AS zig
  ), nows AS (
    SELECT coalesce(typed_usd, public.price_rounded_up(typed_zig, 1, rate, usd_step), n.usd) AS usd,
           coalesce(typed_zig, public.price_rounded_up(typed_usd, rate, 1, zig_step), n.zig) AS zig
    FROM normals n
  )
  SELECT c.currency, c.special, c.normal, c.typed IS NULL
  FROM normals n, nows s,
    LATERAL (VALUES
      ('usd', typed_usd, s.usd, n.usd, mode <> 'zig_only' OR s.zig IS NULL),
      ('zig', typed_zig, s.zig, n.zig, mode <> 'usd_only' OR s.usd IS NULL)
    ) AS c(currency, typed, special, normal, shown),
    LATERAL (SELECT num_nulls(item_usd, item_zig) = 1 AS one_price,
                    num_nulls(typed_usd, typed_zig) = 1 AS one_typed) AS f
  WHERE c.special > c.normal
    AND CASE
      WHEN c.typed IS NULL THEN c.shown AND NOT f.one_price
      ELSE c.shown OR (f.one_price AND f.one_typed)
    END
  ORDER BY c.typed IS NULL, c.currency
  LIMIT 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION special_above_normal(numeric, numeric, numeric, numeric, numeric, numeric, numeric, public.currency_mode) FROM PUBLIC;
--> statement-breakpoint
-- THE RACE: a special and the price it is judged by are on different rows, so a new
-- special and a new price could each pass without seeing the other uncommitted. They
-- meet on an advisory lock keyed by the restaurant (a rate is judged against every
-- special it has), taken in one statement and judged in the next: whoever waited
-- sees what the other committed (READ COMMITTED takes a snapshot per statement).
-- Transaction-level, so it ends with the transaction.
--
-- AFTER triggers, so RLS and the foreign keys have already refused a row forged for
-- another restaurant, and SECURITY DEFINER so the judgement sees every special
-- whatever the caller's RLS shows.
--
-- LOCK ORDER. A write holds its own row, then takes this lock, and the judgement
-- locks no row, so a holder waits on nobody here. Nothing that takes it takes
-- another advisory lock, and what the app writes after it is an audit row.
--
-- The error's DETAIL is what the owner is told: menu names and prices, which are on
-- the public page, and only of the restaurant being written.
CREATE FUNCTION specials_not_above_normal() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  tenant uuid;
  only_item uuid;
  only_special uuid;
  current_rate numeric;
  above jsonb;
BEGIN
  IF TG_TABLE_NAME = 'restaurants' THEN
    tenant := NEW.id;
  ELSE
    tenant := NEW.restaurant_id;
  END IF;
  IF TG_TABLE_NAME = 'specials' THEN
    only_special := NEW.id;
  ELSIF TG_TABLE_NAME = 'menu_items' THEN
    only_item := NEW.id;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('special_prices:' || tenant::text, 0));

  SELECT x.usd_to_zig INTO current_rate
  FROM public.exchange_rates x
  WHERE x.restaurant_id = tenant
  ORDER BY x.created_at DESC, x.id DESC
  LIMIT 1;

  SELECT jsonb_agg(jsonb_build_object(
           'item', m.name, 'title', s.title, 'currency', a.currency,
           'special', a.special::text, 'normal', a.normal::text, 'calculated', a.calculated
         ) ORDER BY m.name, s.id)
  INTO above
  FROM public.specials s
  JOIN public.menu_items m ON m.restaurant_id = s.restaurant_id AND m.id = s.menu_item_id
  JOIN public.restaurants r ON r.id = s.restaurant_id
  CROSS JOIN LATERAL public.special_above_normal(
    m.price_usd, m.price_zig, s.special_price_usd, s.special_price_zig,
    current_rate, r.usd_rounding_step, r.zig_rounding_step, r.currency_mode
  ) a
  WHERE s.restaurant_id = tenant
    AND s.active
    AND (s.ends_at IS NULL OR s.ends_at > now())
    AND m.archived_at IS NULL
    AND (only_item IS NULL OR s.menu_item_id = only_item)
    AND (only_special IS NULL OR s.id = only_special);

  IF above IS NOT NULL THEN
    RAISE EXCEPTION 'a special can''t be above the normal price'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'specials_not_above_normal', DETAIL = above::text;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION specials_not_above_normal() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER specials_not_above_normal
  AFTER INSERT OR UPDATE OF active, menu_item_id, special_price_usd, special_price_zig, starts_at, ends_at ON specials
  FOR EACH ROW WHEN (
    NEW.active AND (NEW.special_price_usd IS NOT NULL OR NEW.special_price_zig IS NOT NULL)
  )
  EXECUTE FUNCTION specials_not_above_normal();
--> statement-breakpoint
CREATE TRIGGER specials_not_above_normal
  AFTER UPDATE OF price_usd, price_zig, archived_at ON menu_items
  FOR EACH ROW WHEN (
    NEW.archived_at IS NULL
    AND (OLD.price_usd IS DISTINCT FROM NEW.price_usd
      OR OLD.price_zig IS DISTINCT FROM NEW.price_zig
      OR OLD.archived_at IS NOT NULL)
  )
  EXECUTE FUNCTION specials_not_above_normal();
--> statement-breakpoint
-- The owner role can also correct a rate in place; tenants only add (0018).
CREATE TRIGGER specials_not_above_normal
  AFTER INSERT OR UPDATE OF usd_to_zig, created_at ON exchange_rates
  FOR EACH ROW
  EXECUTE FUNCTION specials_not_above_normal();
--> statement-breakpoint
CREATE TRIGGER specials_not_above_normal
  AFTER UPDATE OF currency_mode, usd_rounding_step, zig_rounding_step ON restaurants
  FOR EACH ROW WHEN (
    OLD.currency_mode IS DISTINCT FROM NEW.currency_mode
    OR OLD.usd_rounding_step IS DISTINCT FROM NEW.usd_rounding_step
    OR OLD.zig_rounding_step IS DISTINCT FROM NEW.zig_rounding_step
  )
  EXECUTE FUNCTION specials_not_above_normal();
