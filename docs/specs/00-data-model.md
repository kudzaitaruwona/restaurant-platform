# 00 · Data Model

This is a reference schema written as Postgres-style pseudocode. It is not a migration file. The real migrations live in `db/` and are generated from the ORM schema once phase 1 starts.

## Ground rules (decided)

- **Every table carries `restaurant_id`.** Every foreign key between tenant tables is composite, for example `(restaurant_id, session_id)`, so a bug in the app can't link rows across restaurants. **Notation:** in the pseudocode below, `x_id → parent` is shorthand for the composite FK `(restaurant_id, x_id) → parent(restaurant_id, id)`, and every tenant parent table has `UNIQUE (restaurant_id, id)` to support it.
- **Every "who did this" column points to `staff`**, except `audit_log.actor_id`, which holds a `platform_admins` id (S-29), and *(proposed, S-33)* `onboarding_checklist.qr_codes_printed_by`, which does the same with no foreign key. When the platform admin enters a restaurant, the system creates (once) a shadow staff row in that tenant with `kind = platform_admin`. There is one per restaurant, shared by every platform admin (S-28). That row has no email and can't log in. Admin actions then satisfy the same FKs as staff actions, and the audit log still records `actor_type = platform_admin`.
- **Row-level security on `restaurant_id`** sits on top of the composite keys as a second layer.
- **Nothing customer-facing is hard-deleted.** Menu items and tables use `archived_at`.
- **All timestamps are `timestamptz`.** Each restaurant has a `timezone`, which defaults to `Africa/Harare` (CAT, UTC+2, no daylight saving). Opening hours are local `time` values and are interpreted in that zone.
- **Rules that protect money or seats live in the database**, as constraints and triggers, not only in app code.

**Tables that don't carry `restaurant_id`.** The rules above govern tenant tables. Better Auth's sign-in tables (`staff_auth_*` and `admin_auth_*`, including `staff_auth_code_limit`, `admin_auth_code_limit` and `admin_auth_entry`, which holds the restaurant an admin session has entered) belong to no restaurant: they exist before anyone has a tenant, and a credential must be unreachable from inside one. They have RLS, with the reverse of the tenant policy, so rows are visible only when no tenant is set. They are not listed in this spec's schema. S-30 in `docs/decisions.md` records them, their policy and how retention works, and S-28 which login reaches which. *(Proposed)* `booking_rate_limit` (spec 04, abuse controls) has no `restaurant_id` either and the same reverse policy, because an attempt is counted before the slug resolves, so there is no tenant yet.

## 1. Tenant, staff, platform

```sql
restaurants
  id                    uuid pk
  name                  text
  slug                  text unique          -- public URLs: /r/{slug}
  menu_token            text unique          -- generic "View our menu" QR, read-only
  timezone              text default 'Africa/Harare'
  contact_phone         text null            -- E.164; large-party + "call us" links
  currency_mode         enum(usd_only, zig_only, usd_primary, zig_primary, both)
  zig_rounding_step     numeric default 10   -- computed ZiG prices round UP to this
  usd_rounding_step     numeric default 0.01
  CHECK (zig_rounding_step > 0 AND zig_rounding_step < 'Infinity' AND usd_rounding_step > 0 AND usd_rounding_step < 'Infinity')  -- restaurants_rounding_steps_positive_finite (proposed): > 0 because a step of 0 divides by zero in the effective-price formula, and negative or -Infinity is not a step. Added by issue 20, which computes with both steps, in migration 0014 (the table existed without either check)
  wifi_name, wifi_password  text null        -- printed on the table QR sheet
  created_at

staff
  id, restaurant_id → restaurants
  kind                  enum(staff, platform_admin) default 'staff'
  email                 text unique null     -- global and case-insensitive (S-30), used for sign-in; null for platform_admin rows
  -- S-27: passwordless sign-in (magic link, email code, Google). No password column.
  CHECK (kind = 'platform_admin' OR email IS NOT NULL)
  CHECK (kind = 'staff' OR (email IS NULL AND role = 'owner' AND active))   -- S-28; `AND active` (proposed)
  UNIQUE (restaurant_id) WHERE kind = 'platform_admin'                      -- S-28: one shadow row each
  -- platform_admin rows never count toward the soft limit, which counts owner logins only (S-26)
  display_name          text                 -- appears in the audit log
  role                  enum(owner, staff) default 'staff'   -- S-26; the first staff record of a restaurant is 'owner'
  -- S-26: a trigger rejects any change (deactivate, demote, delete) that would leave the
  -- restaurant with no active owner. platform_admin shadow rows have role = 'owner' for
  -- permission checks but never count as owners for this rule or the soft limit.
  active                bool default true
  created_at

platform_admins                               -- Kudzai, for hand-onboarding
  id, email unique, created_at                -- case-insensitive; passwordless sign-in (S-27)

onboarding_checklist                          -- (proposed, S-33) separate table; admin only (app_tenant has no privilege); a row means "QR codes printed" is ticked (proposed)
  restaurant_id         pk → restaurants    -- cascade; the other checklist items are derived, not stored
  qr_codes_printed_at, qr_codes_printed_by    -- an admin's id, no foreign key (proposed; revoking an admin deletes their row)

audit_log
  id, restaurant_id
  actor_type            enum(staff, platform_admin, system)
  actor_id              uuid null            -- S-29: platform_admins.id when actor_type = platform_admin
  action                text                 -- 'session.force_close', 'booking.cancel', ...
  entity_type, entity_id
  details               jsonb
  created_at
```

## 2. Menu and pricing

```sql
categories
  id, restaurant_id, name, sort_order, archived_at null

menu_items
  id, restaurant_id, category_id → categories      -- exactly one category
  name, description, photo_key null            -- storage key; `-800.webp` and `-320.webp` hang off it (proposed), URLs come from getUrl (D-07)
  price_usd             numeric null
  price_zig             numeric null                -- set = fixed ZiG price
  CHECK (price_usd IS NOT NULL OR price_zig IS NOT NULL)
  CHECK (price_usd >= 0 AND price_zig >= 0)
  CHECK (price_usd < 'Infinity' AND price_zig < 'Infinity')  -- menu_items_prices_finite: a column is finite only with a lower bound and `< 'Infinity'` together. NaN and +Infinity both pass >= 0 and > 0 in Postgres numeric (NaN sorts above Infinity, so `< 'Infinity'` rejects both), and `< 'Infinity'` alone still admits -Infinity and any negative value. Here the adjacent >= 0 supplies the lower bound. Every money column needs both
  visibility            enum(regular, special_only) default 'regular' NOT NULL  -- menu_visibility. special_only = a bundle (spec 02): shown only while one of its specials is live, and in no category. Set when the item is made; no edit changes it. Built in ticket #25 (2.7)
  available             bool default true           -- "kitchen ran out"
  sort_order
  archived_at           null

specials
  id, restaurant_id, menu_item_id → menu_items
  title                 text null          -- badge text: "Taco Tuesday"
  special_price_usd     numeric null       -- null = keep the item's normal price
  special_price_zig     numeric null       -- same fallback-to-rate rule as items
  CHECK (special_price_usd >= 0 AND special_price_zig >= 0)  -- (proposed) lower bound, so a special cannot make a negative bill
  CHECK (special_price_usd < 'Infinity' AND special_price_zig < 'Infinity')  -- specials_prices_finite: finite only together with the >= 0 above
  CHECK (title IS NOT NULL OR special_price_usd IS NOT NULL OR special_price_zig IS NOT NULL)  -- specials_does_something (proposed): a special with no badge and no price would change nothing
  starts_at, ends_at    timestamptz null   -- null ends_at = until turned off; null starts_at = no lower end, only on rows not written through the form, which stores a blank start as now() (proposed). Half-open: [starts_at, ends_at)
  CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)  -- specials_window_ordered (proposed)
  days_of_week          int[] null         -- D-04: column now, logic later
  daily_start, daily_end time null         -- D-04
  active                bool default true
  FOREIGN KEY (restaurant_id, menu_item_id) → menu_items  -- specials_menu_item_fk, composite like every tenant FK
  -- D-05 (proposed): specials_no_overlap, written in migration 0019_specials because Drizzle can't model it:
  --   EXCLUDE USING gist (restaurant_id WITH =, menu_item_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE (active)
  -- needs btree_gist (migration 0000; Neon supports it). A null bound is unbounded in tstzrange, which is what
  -- "no end date" means, and "no start date" on a row not written through the form; a special that is off holds no time; one that ends where the next
  -- begins does not overlap. Turning a special back on re-runs the check, so it can be refused too.

exchange_rates                              -- history; the current rate is the latest row
  id, restaurant_id
  usd_to_zig            numeric CHECK (> 0 AND < 'Infinity')   -- exchange_rates_usd_to_zig_finite: > 0 alone lets NaN and Infinity through, and `< 'Infinity'` alone lets negatives through; both together are finite
  set_by → staff
  created_at
```

**Effective price is computed, never stored:**

```
effective_zig = coalesce(price_zig, ceil(price_usd * rate / zig_step) * zig_step)
effective_usd = coalesce(price_usd, ceil(price_zig / rate / usd_step) * usd_step)
zig_source    = price_zig IS NULL ? 'calculated' : 'fixed'
```

A special overrides the price for the item it points to while it is active. The order of precedence for each currency is:

```
special_zig = coalesce(special_price_zig,
                       special_price_usd IS NOT NULL ? ceil(special_price_usd * rate / zig_step) * zig_step : NULL,
                       effective_zig)          -- badge-only special: normal price
special_usd = coalesce(special_price_usd,
                       special_price_zig IS NOT NULL ? ceil(special_price_zig / rate / usd_step) * usd_step : NULL,
                       effective_usd)
```

Setting a discount in one currency therefore discounts both, even when the item has a fixed ZiG price.

Where a currency can't be worked out (no rate set yet), the formula falls through to the item's normal price in that currency, so a ZiG-only special on a USD-only item shows the normal USD price until there is a rate. `src/lib/pricing.ts` (`specialZig`, `specialUsd`) holds this, in BigInt like the effective prices.

**A special's dates are dates in `restaurants.timezone` *(proposed)*.** The owner picks a start date and an end date, never a time. A start date is that day's 00:00 in the restaurant's zone; an end date is inclusive, so `ends_at` is the 00:00 after it. Postgres does the conversion (`date::timestamp AT TIME ZONE restaurants.timezone`), so it uses the zone's rules for that day, not the server's. "Until Sunday" in Harare is `ends_at = Sunday 22:00 UTC`. A blank start date is stored as the transaction's `now()`, because a special that is over stays active and an open lower end would overlap it.

## 3. Tables

```sql
tables
  id, restaurant_id
  label                 text                  -- "7", "B2", "Patio 1"
  capacity              int CHECK (> 0)       -- the app also caps it at 100, and a label at 50 characters (proposed, spec 03)
  bookable              bool default true     -- false = walk-ins only
  sort_order
  qr_token              text unique           -- ≥128 bits random, base62
  CHECK (qr_token ~ '^[0-9A-Za-z]{22,}$')    -- tables_qr_token_shape (proposed): 22 base62 characters is 131 bits, so a short or odd token can't be stored
  token_rotated_at      timestamptz null
  archived_at           null
  UNIQUE (restaurant_id, label) WHERE archived_at IS NULL
  -- (proposed) archive guard (migration 0023, spec 03): an AFTER UPDATE OF archived_at trigger refuses to archive a table
  -- while a booking holds it: status IN ('confirmed','seated') AND hold_ends_at > now() (booking_holds_table()).
  -- It takes pg_advisory_xact_lock(hashtextextended('table_seat:' || id, 0)) first, in its own statement, so it waits for
  -- inserts in flight and sees them.
```

## 4. Bookings

```sql
booking_settings                            -- one row per restaurant
  restaurant_id         pk → restaurants
  enabled               bool default false
  slot_interval_minutes int default 15
  sitting_minutes       int default 90
  large_party_size      int default 5       -- this size and above gets the longer sitting
  large_party_sitting_minutes int default 120
  buffer_minutes        int default 15      -- reset time between bookings on a table
  min_lead_minutes      int default 60      -- no bookings closer than this to now
  max_days_ahead        int default 30
  max_online_party_size int default 8
  guest_cancel_cutoff_minutes int default 120
  max_active_bookings_per_phone int default 2
  -- (proposed) a row is made by a trigger when the restaurant is created. Also an `id` column,
  -- UNIQUE (restaurant_id, id), because every tenant table has one for composite keys.
  -- (proposed) every number is bounded by a CHECK: intervals and sittings 1-720 minutes (slot interval
  -- 1-240), buffer 0-240, lead time and cancel cutoff 0-10080, days ahead 0-365, party sizes 1-100,
  -- active bookings per phone 1-20.
  -- (proposed) enabled = true requires a service period, a bookable non-archived table and
  -- restaurants.contact_phone: a trigger refuses to enable without them and switches booking off
  -- when the last one goes (spec 04 › Settings).

service_periods                             -- several per day allowed (lunch, dinner)
  id, restaurant_id
  name                  text                -- "Lunch", "Dinner"; groups times on the booking page
  weekday               int CHECK (0..6)    -- 0 = Sunday
  opens_at              time
  last_booking_at       time                -- latest start time a guest can book
  closes_at             time                -- end of service; used for "outside hours" metric
  CHECK (opens_at <= last_booking_at AND last_booking_at < closes_at)
  -- v1: periods don't cross midnight (closes_at ≤ 23:59). Late-night venues are out of scope.
  -- (proposed) name is 1-50 characters after trimming; CHECK (closes_at <= '23:59').
  -- No two periods on the same weekday may overlap:
  EXCLUDE USING gist (restaurant_id WITH =, weekday WITH =,
                      int4range(minutes(opens_at), minutes(closes_at)) WITH &&)
  -- (proposed) built with whole seconds, extract(epoch from opens_at)::int, since `minutes()` isn't a function;
  -- ranges are half-open, so two periods can touch.

closures                                    -- holidays, private events
  id, restaurant_id, starts_at, ends_at, reason text null
  -- a date-only closure is stored as local midnight → next local midnight,
  -- converted with restaurants.timezone
  -- (proposed, #38) UNIQUE (restaurant_id, id); CHECK (starts_at < ends_at); CHECK a reason is
  -- non-blank and at most 200 characters; an index on (restaurant_id, ends_at), so a read that
  -- starts from an instant never walks past closures. The two guards are triggers in migration
  -- 0026: closures_cover_bookings refuses a closure over a confirmed booking's sitting, and
  -- bookings_within_closure refuses a confirmed booking inside one (spec 04 › Settings).

bookings
  id, restaurant_id
  table_id              → tables
  guest_name            text not null CHECK (trim(guest_name) <> '')
  guest_phone           text null           -- E.164; nulled by retention job (D-06)
  guest_phone_set       bool not null       -- (proposed, migration 0033) GENERATED ALWAYS AS (guest_phone IS NOT NULL) STORED,
                                            -- so the job finds rows to purge without reading the number (D-06, S-28)
  whatsapp_opt_in       bool not null
  party_size            int CHECK (> 0)
  starts_at             timestamptz
  ends_at               timestamptz         -- starts_at + sitting length
  hold_ends_at          timestamptz         -- ends_at + buffer
  status                enum(confirmed, seated, completed, cancelled, no_show)
  source                enum(online, staff)
  guest_note            text null           -- "birthday", max 200 chars
  manage_token          text unique         -- guest's cancel link
  cancelled_by          enum(guest, staff) null
  cancelled_at          timestamptz null
  created_at

  CHECK (starts_at < ends_at AND ends_at <= hold_ends_at)
  CHECK (hold_ends_at - starts_at <= interval '960 minutes')  -- bookings_hold_capped (proposed): largest sitting 720 + largest buffer 240 (booking_settings' CHECKs); the availability read relies on it
  -- (proposed) Finish and automatic completion (spec 04) clamp `ends_at` and `hold_ends_at` so `hold_ends_at - starts_at` stays within 960 minutes; a seated booking finished the next morning would otherwise violate this CHECK.

  -- THE double-booking guard (requires btree_gist):
  EXCLUDE USING gist (
    table_id WITH =,
    tstzrange(starts_at, hold_ends_at) WITH &&
  ) WHERE (status IN ('confirmed', 'seated', 'completed'))

  -- (proposed) bookings_table_live (migration 0023): AFTER INSERT, and AFTER UPDATE OF table_id, status when the booking
  -- newly claims a table, refuse a booking that holds its table (booking_holds_table()) on an archived table, and an
  -- online one on a bookable = false table. It takes the same advisory lock SHARED first, so two inserts never wait on each
  -- other and an archive and an insert order themselves: whichever commits second sees the other. Neither takes a row lock
  -- on tables, so moveTable's NO KEY UPDATE and a booking's foreign key check still don't block one another.
  -- (proposed) bookings_max_active_per_phone (migration 0024): AFTER INSERT of a confirmed online booking with a phone, it takes
  -- an advisory lock per (restaurant, phone) and counts (spec 04 › Abuse controls). Triggers fire in name order, so an insert takes
  -- the phone's lock, then the table's. An archive takes only the table's, and a failed attempt gives both back with its SAVEPOINT,
  -- so neither can wait on the other in a cycle, as long as a transaction makes one booking (src/db/booking-lock-order.int.test.ts).
  -- It fires on insert only. A move leaves the count as it was, so it needs nothing. A reopen would add a booking the rule never
  -- saw, but nothing reopens one (spec 04: nothing leads out of cancelled): whatever adds that must decide whether the limit applies.
  -- (proposed) table_id is NOT NULL and its foreign key is composite, (restaurant_id, table_id).
  -- UNIQUE (restaurant_id, id), and an index on (restaurant_id, starts_at) for the day list.
  -- (proposed) Partial indexes for the scheduled job (S-35), which looks across every restaurant and so can't use the
  -- day list's: ends_at WHERE status = 'confirmed' and hold_ends_at WHERE status = 'seated' (migration 0031) for spec 04's
  -- automatic status changes, and starts_at WHERE guest_phone_set (migration 0033, replacing 0032's starts_at WHERE
  -- guest_phone IS NOT NULL) for D-06's phone purge. Each holds only rows the job might still change (confirmed, seated, or still holding a number).
  -- (proposed) bookings_system_phone_null_only (migration 0033): BEFORE INSERT OR UPDATE OF guest_phone, refuses a non-null
  -- guest_phone written while current_user is app_system, which may only null it (D-06, S-28).
  -- (proposed) CHECKs: guest_name up to 100 characters; guest_phone is E.164 (8 to 15 digits);
  -- manage_token is at least 22 base62 characters, the same as a table's QR token.
```

The exclusion constraint makes double-booking impossible even when two guests submit at the same moment. `completed` stays inside the constraint so the reset buffer after an early finish is still respected (see spec 04, "Finish"). `cancelled` and `no_show` free the table.

**Retrying across candidate tables:** a constraint violation aborts the surrounding Postgres transaction. Each candidate attempt must therefore run inside its own `SAVEPOINT` (roll back to the savepoint on `exclusion_violation`, then try the next table), or in its own short transaction.

## 5. Notifications (outbox)

```sql
notifications
  id, restaurant_id, booking_id → bookings
  kind                  enum(booking_confirmed, booking_reminder, booking_cancelled)
  channel               enum(whatsapp)
  scheduled_for         timestamptz
  status                enum(pending, sending, sent, delivered, read, failed, cancelled)
  claimed_at            timestamptz null   -- set when a job run claims the row (pending → sending)
  provider_message_id   text null
  attempts              int default 0
  last_error            text null
  created_at
  UNIQUE (booking_id, kind)                 -- never send the same message twice
```

Built in ticket #44 (migration 0034). Like every tenant table it has `UNIQUE (restaurant_id, id)`, a composite foreign key to `bookings` and the tenant policy. `channel` defaults to `whatsapp` and `status` to `pending`. `scheduled_for` is when a row becomes due: the confirmation at the moment of confirming. A partial index on `scheduled_for` where `status = 'pending'` serves the job. Checks: `attempts >= 0`, a `sending` row has `claimed_at`, and `last_error` is at most 500 characters. The row is written by `app_tenant` in the booking's transaction; the job (`app_system`) may read only the columns that pick and claim a due row, and write only `status`, `claimed_at`, `attempts`, `last_error` and `provider_message_id`.

`notification_sends` *(proposed, S-36)* is a view joining a notification to its booking and restaurant (the guest's name, number, opt-in, party size, start, manage token, and the restaurant's name, contact phone and timezone), showing only rows in `sending`. It is how the job reads what it sends without a grant on those columns for every booking. Only `app_system` may read it.

## 6. Table sessions and orders (phase 6; see spec 06)

```sql
table_sessions
  id, restaurant_id, table_id
  status                enum(open, closed)
  approved_at           timestamptz null   -- only used if D-01 picks staff approval
  opened_at, last_activity_at              -- bumped by scans, orders, item status changes, reopen
  waiter_requested_at   timestamptz null   -- "call a waiter" flag (proposed)
  closed_at
  close_reason          enum(in_app_payment, staff_clear, idle_expiry,
                             pos_payment, force_close) null
  closed_by             → staff null       -- null when automatic
  paid_currency         enum(usd, zig) null
  UNIQUE (table_id) WHERE status = 'open'  -- the table lock

orders
  id, restaurant_id, session_id
  customer_name         text not null CHECK (trim(customer_name) <> '')
  rate_used             numeric null       -- exchange rate frozen at order time
  CHECK (rate_used > 0)                    -- (proposed) lower bound, so a frozen rate cannot give a negative ZiG price
  CHECK (rate_used < 'Infinity')           -- orders_rate_used_finite: finite only together with the > 0 above
  placed_at

order_items
  id, restaurant_id, order_id, menu_item_id
  special_id            → specials null    -- for "how many did the special sell"
  name_snapshot         text
  quantity              int CHECK (> 0)
  unit_price_usd, unit_price_zig  numeric  -- frozen
  CHECK (unit_price_usd >= 0 AND unit_price_zig >= 0)  -- (proposed) lower bound, so a frozen price cannot make a negative bill
  CHECK (unit_price_usd < 'Infinity' AND unit_price_zig < 'Infinity')  -- order_items_prices_finite: finite only together with the >= 0 above
  zig_source            enum(fixed, calculated)
  note                  text null          -- per item: "no onions"
  status                enum(placed, cooking, done, delivered, voided)
  status_changed_at
  void_reason           text null
  voided_by             → staff null
  CHECK (status <> 'voided' OR (void_reason IS NOT NULL AND voided_by IS NOT NULL))
```

### Enforced in the database
- **Table lock:** a partial unique index allows only one open session per table.
- *(Proposed, #38)* **Booking closures:** a closure can't be saved over a confirmed booking whose sitting runs into it, and a confirmed booking can't be made inside a closure, whichever commits first (migration 0026; one advisory lock per restaurant, as the archive guard's is per table).
- **Closure gate:** a trigger rejects `status → closed` while any item is not `delivered` or `voided`. It applies to every close path.
- **Force-close:** one transaction voids the remaining items with a reason, then closes the session.
- **Reopen:** allowed only if `closed_at > now() - 15 min` **and** no session on that table has `opened_at > this.closed_at`, whether that newer session is open or already closed. Reopening also sets `last_activity_at = now()`, so idle expiry doesn't immediately close the session again.
- **Orders:** an insert fails unless the session is `open`.
