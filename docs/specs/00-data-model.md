# 00 · Data Model

This is a reference schema written as Postgres-style pseudocode. It is not a migration file. The real migrations live in `db/` and are generated from the ORM schema once phase 1 starts.

## Ground rules (decided)

- **Every table carries `restaurant_id`.** Every foreign key between tenant tables is composite, for example `(restaurant_id, session_id)`, so a bug in the app can't link rows across restaurants. **Notation:** in the pseudocode below, `x_id → parent` is shorthand for the composite FK `(restaurant_id, x_id) → parent(restaurant_id, id)`, and every tenant parent table has `UNIQUE (restaurant_id, id)` to support it.
- **Every "who did this" column points to `staff`.** When the platform admin enters a restaurant, the system creates (once) a shadow staff row in that tenant with `kind = platform_admin`. That row has no email and no password, and can't log in. Admin actions then satisfy the same FKs as staff actions, and the audit log still records `actor_type = platform_admin`.
- **Row-level security on `restaurant_id`** sits on top of the composite keys as a second layer.
- **Nothing customer-facing is hard-deleted.** Menu items and tables use `archived_at`.
- **All timestamps are `timestamptz`.** Each restaurant has a `timezone`, which defaults to `Africa/Harare` (CAT, UTC+2, no daylight saving). Opening hours are local `time` values and are interpreted in that zone.
- **Rules that protect money or seats live in the database**, as constraints and triggers, not only in app code.

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
  wifi_name, wifi_password  text null        -- printed on the table QR sheet
  created_at

staff
  id, restaurant_id → restaurants
  kind                  enum(staff, platform_admin) default 'staff'
  email                 text unique null     -- global, used for login; null for platform_admin rows
  password_hash         null                 -- null for platform_admin rows
  CHECK (kind = 'platform_admin' OR (email IS NOT NULL AND password_hash IS NOT NULL))
  -- platform_admin rows never count toward the soft limit, which counts owner logins only (S-26)
  display_name          text                 -- appears in the audit log
  role                  enum(owner, staff) default 'staff'   -- S-26; the first staff record of a restaurant is 'owner'
  -- S-26: a trigger rejects any change (deactivate, demote, delete) that would leave the
  -- restaurant with no active owner. platform_admin shadow rows have role = 'owner' for
  -- permission checks but never count as owners for this rule or the soft limit.
  active                bool default true
  created_at

platform_admins                               -- Kudzai, for hand-onboarding
  id, email unique, password_hash, created_at

audit_log
  id, restaurant_id
  actor_type            enum(staff, platform_admin, system)
  actor_id              uuid null
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
  name, description, photo_url null
  price_usd             numeric null
  price_zig             numeric null                -- set = fixed ZiG price
  CHECK (price_usd IS NOT NULL OR price_zig IS NOT NULL)
  visibility            enum(regular, special_only) default 'regular'
  is_available          bool default true           -- "kitchen ran out"
  sort_order
  archived_at           null

specials
  id, restaurant_id, menu_item_id → menu_items
  title                 text null          -- badge text: "Taco Tuesday"
  special_price_usd     numeric null       -- null = keep the item's normal price
  special_price_zig     numeric null       -- same fallback-to-rate rule as items
  starts_at, ends_at    timestamptz null   -- null ends_at = until turned off
  days_of_week          int[] null         -- D-04: column now, logic later
  daily_start, daily_end time null         -- D-04
  active                bool
  -- D-05 (proposed): exclusion constraint, no two active overlapping specials per item

exchange_rates                              -- history; the current rate is the latest row
  id, restaurant_id
  usd_to_zig            numeric CHECK (> 0)
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

## 3. Tables

```sql
tables
  id, restaurant_id
  label                 text                  -- "7", "B2", "Patio 1"
  capacity              int CHECK (> 0)
  bookable              bool default true     -- false = walk-ins only
  sort_order
  qr_token              text unique           -- ≥128 bits random, base62
  token_rotated_at      timestamptz null
  archived_at           null
  UNIQUE (restaurant_id, label) WHERE archived_at IS NULL
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

service_periods                             -- several per day allowed (lunch, dinner)
  id, restaurant_id
  name                  text                -- "Lunch", "Dinner"; groups times on the booking page
  weekday               int CHECK (0..6)    -- 0 = Sunday
  opens_at              time
  last_booking_at       time                -- latest start time a guest can book
  closes_at             time                -- end of service; used for "outside hours" metric
  CHECK (opens_at <= last_booking_at AND last_booking_at < closes_at)
  -- v1: periods don't cross midnight (closes_at ≤ 23:59). Late-night venues are out of scope.
  -- No two periods on the same weekday may overlap:
  EXCLUDE USING gist (restaurant_id WITH =, weekday WITH =,
                      int4range(minutes(opens_at), minutes(closes_at)) WITH &&)

closures                                    -- holidays, private events
  id, restaurant_id, starts_at, ends_at, reason text null
  -- a date-only closure is stored as local midnight → next local midnight,
  -- converted with restaurants.timezone

bookings
  id, restaurant_id
  table_id              → tables
  guest_name            text not null CHECK (trim(guest_name) <> '')
  guest_phone           text null           -- E.164; nulled by retention job (D-06)
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

  -- THE double-booking guard (requires btree_gist):
  EXCLUDE USING gist (
    table_id WITH =,
    tstzrange(starts_at, hold_ends_at) WITH &&
  ) WHERE (status IN ('confirmed', 'seated', 'completed'))
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
  placed_at

order_items
  id, restaurant_id, order_id, menu_item_id
  special_id            → specials null    -- for "how many did the special sell"
  name_snapshot         text
  quantity              int CHECK (> 0)
  unit_price_usd, unit_price_zig  numeric  -- frozen
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
- **Closure gate:** a trigger rejects `status → closed` while any item is not `delivered` or `voided`. It applies to every close path.
- **Force-close:** one transaction voids the remaining items with a reason, then closes the session.
- **Reopen:** allowed only if `closed_at > now() - 15 min` **and** no session on that table has `opened_at > this.closed_at`, whether that newer session is open or already closed. Reopening also sets `last_activity_at = now()`, so idle expiry doesn't immediately close the session again.
- **Orders:** an insert fails unless the session is `open`.
