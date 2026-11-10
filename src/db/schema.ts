import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * The Drizzle schema. `npm run db:generate` diffs it against db/migrations and
 * writes the next migration. Tables arrive with the tickets that need them;
 * the data model is docs/specs/00-data-model.md.
 *
 * Every tenant table needs `tenantPolicy("restaurant_id")` and
 * `UNIQUE (restaurant_id, id)`, and its foreign keys to other tenant tables
 * must be composite. src/db/rls.int.test.ts fails on a table that has
 * restaurant_id and no policy.
 */

/**
 * RLS is tenant-only (S-26): rows are visible and writable only inside
 * withTenant(), which sets app.restaurant_id for its transaction. nullif is
 * load-bearing: on a pooled connection a tenant has used, the setting reverts
 * to '' rather than to unset, and ''::uuid would throw instead of matching
 * nothing.
 */
function tenantPolicy(column: "id" | "restaurant_id") {
  const sameTenant = sql`${sql.identifier(column)} = nullif(current_setting('app.restaurant_id', true), '')::uuid`;
  return pgPolicy("tenant_isolation", {
    for: "all",
    using: sameTenant,
    withCheck: sameTenant,
  });
}

/**
 * The reverse of tenantPolicy, for what belongs to no restaurant: visible only
 * outside a tenant, so nothing inside withTenant() can read or change it. Same
 * nullif, for the same reason.
 */
function outsideTenantOnly() {
  const noTenant = sql`nullif(current_setting('app.restaurant_id', true), '') is null`;
  return pgPolicy("outside_tenant_only", {
    for: "all",
    using: noTenant,
    withCheck: noTenant,
  });
}

export const currencyMode = pgEnum("currency_mode", [
  "usd_only",
  "zig_only",
  "usd_primary",
  "zig_primary",
  "both",
]);

export const staffKind = pgEnum("staff_kind", ["staff", "platform_admin"]);

export const auditActorType = pgEnum("audit_actor_type", [
  "staff",
  "platform_admin",
  "system",
]);

export const staffRole = pgEnum("staff_role", ["owner", "staff"]);

export const bookingStatus = pgEnum("booking_status", [
  "confirmed",
  "seated",
  "completed",
  "cancelled",
  "no_show",
]);

export const bookingSource = pgEnum("booking_source", ["online", "staff"]);

export const bookingCancelledBy = pgEnum("booking_cancelled_by", ["guest", "staff"]);

// special_only is a bundle (spec 02): it shows only while one of its specials is on.
export const menuVisibility = pgEnum("menu_visibility", ["regular", "special_only"]);

// Spec 00, 6: table sessions and orders (phase 6, spec 06).
export const tableSessionStatus = pgEnum("table_session_status", ["open", "closed"]);

export const tableSessionCloseReason = pgEnum("table_session_close_reason", [
  "in_app_payment",
  "staff_clear",
  "idle_expiry",
  "pos_payment",
  "force_close",
]);

export const paidCurrency = pgEnum("paid_currency", ["usd", "zig"]);

/** Whether a frozen ZiG price was the item's own or worked out from the rate (S-10). */
export const zigSource = pgEnum("zig_source", ["fixed", "calculated"]);

export const orderItemStatus = pgEnum("order_item_status", [
  "placed",
  "cooking",
  "done",
  "delivered",
  "voided",
]);

export const restaurants = pgTable(
  "restaurants",
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    slug: text().notNull().unique(),
    menuToken: text("menu_token").notNull().unique(),
    timezone: text().notNull().default("Africa/Harare"),
    contactPhone: text("contact_phone"),
    currencyMode: currencyMode("currency_mode").notNull(),
    zigRoundingStep: numeric("zig_rounding_step").notNull().default("10"),
    usdRoundingStep: numeric("usd_rounding_step").notNull().default("0.01"),
    wifiName: text("wifi_name"),
    wifiPassword: text("wifi_password"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  // The tenant root: its id is the tenant, so it has no restaurant_id.
  (table) => [
    check(
      "restaurants_contact_phone_e164",
      sql`${table.contactPhone} ~ '^[+][1-9][0-9]{1,14}$'`,
    ),
    // A step of 0 divides by zero in the effective-price formula (spec 00), and
    // numeric takes NaN and Infinity, so each needs both bounds.
    check(
      "restaurants_rounding_steps_positive_finite",
      sql`${table.zigRoundingStep} > 0 and ${table.zigRoundingStep} < 'Infinity' and ${table.usdRoundingStep} > 0 and ${table.usdRoundingStep} < 'Infinity'`,
    ),
    tenantPolicy("id"),
  ],
);

/**
 * A trigger in the migrations keeps every restaurant at least one active owner
 * (S-26): see 0005_last_owner_and_contact_phone. Drizzle doesn't model triggers.
 */
export const staff = pgTable(
  "staff",
  {
    id: uuid().primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id").notNull(),
    kind: staffKind().notNull().default("staff"),
    email: text().unique(),
    displayName: text("display_name").notNull(),
    role: staffRole().notNull().default("staff"),
    active: boolean().notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.restaurantId],
      foreignColumns: [restaurants.id],
    }),
    unique().on(table.restaurantId, table.id),
    // Sign-in compares emails without case, so uniqueness has to as well: one
    // email must resolve to one person and so to one restaurant (S-30).
    uniqueIndex("staff_email_lower_unique").on(sql`lower(${table.email})`),
    // One shadow row per restaurant, however many first entries race (spec 00).
    uniqueIndex("staff_one_shadow_per_restaurant")
      .on(table.restaurantId)
      .where(sql`${table.kind} = 'platform_admin'`),
    check(
      "staff_email_required",
      sql`${table.kind} = 'platform_admin' or ${table.email} is not null`,
    ),
    // A shadow row is only ever this. With no email, sign-in can't find it.
    check(
      "staff_shadow_row",
      sql`${table.kind} = 'staff' or (${table.email} is null and ${table.role} = 'owner' and ${table.active})`,
    ),
    tenantPolicy("restaurant_id"),
  ],
);

/**
 * Platform admins (Kudzai) sign in here, not through `staff`. Not a tenant
 * table: no restaurant_id, and app_tenant is granted nothing on it (see the
 * migration), so only the system and admin paths can read it. RLS is on with
 * no policy as a second lock.
 */
export const platformAdmins = pgTable(
  "platform_admins",
  {
    id: uuid().primaryKey().defaultRandom(),
    email: text().notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("platform_admins_email_lower_unique").on(
      sql`lower(${table.email})`,
    ),
  ],
).enableRLS();

/**
 * The one onboarding item that can't be derived from the restaurant's data
 * (spec 01): that its QR codes have been printed, ticked by the platform admin.
 * A row means ticked and unticking deletes it. Admin only: app_tenant is
 * granted nothing on it (see 0028), so the checklist never reaches an owner,
 * and app_admin touches it through platform_set_qr_codes_printed alone.
 * `qr_codes_printed_by` is a platform admin, who belongs to no restaurant, so it
 * is not a composite key into staff. It has no foreign key to platform_admins,
 * as `audit_log.actor_id` has none: revoking an admin is deleting their row, and
 * a key would refuse that for any admin who has ticked something. The audit row
 * already records who ticked.
 */
export const onboardingChecklist = pgTable(
  "onboarding_checklist",
  {
    restaurantId: uuid("restaurant_id").primaryKey(),
    id: uuid().notNull().defaultRandom(),
    qrCodesPrintedAt: timestamp("qr_codes_printed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    qrCodesPrintedBy: uuid("qr_codes_printed_by").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.restaurantId],
      foreignColumns: [restaurants.id],
    }).onDelete("cascade"),
    unique().on(table.restaurantId, table.id),
    tenantPolicy("restaurant_id"),
  ],
);

/**
 * Append-only: app_tenant is granted SELECT and INSERT only (see the
 * migration), so no tenant code can alter or remove an entry. `actor_id` has no
 * foreign key because it points at staff, a platform admin or nothing,
 * depending on `actor_type`.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid().primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id").notNull(),
    actorType: auditActorType("actor_type").notNull(),
    actorId: uuid("actor_id"),
    action: text().notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    details: jsonb().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.restaurantId],
      foreignColumns: [restaurants.id],
    }),
    unique().on(table.restaurantId, table.id),
    tenantPolicy("restaurant_id"),
  ],
);

/**
 * The menu (spec 00, 2). Columns arrive with the tickets that use them.
 */
export const categories = pgTable(
  "categories",
  {
    id: uuid().primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id").notNull(),
    name: text().notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    // Nothing customer-facing is hard-deleted (spec 00).
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.restaurantId],
      foreignColumns: [restaurants.id],
    }),
    unique().on(table.restaurantId, table.id),
    tenantPolicy("restaurant_id"),
  ],
);

export const menuItems = pgTable(
  "menu_items",
  {
    id: uuid().primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id").notNull(),
    categoryId: uuid("category_id").notNull(),
    name: text().notNull(),
    // Blank rather than null when there's nothing to say: spec 00 marks what can
    // be null, and this isn't one.
    description: text().notNull().default(""),
    priceUsd: numeric("price_usd"),
    // Set means a fixed ZiG price (S-10).
    priceZig: numeric("price_zig"),
    // False while the kitchen has run out (S-26). Staff toggle it from the item list.
    available: boolean().notNull().default(true),
    // special_only is a bundle: the customer's page shows it only while one of
    // its specials is live (spec 02). It is set when the item is made and no
    // edit changes it.
    visibility: menuVisibility().notNull().default("regular"),
    // The photo's storage key without its size: `-800.webp` and `-320.webp` are
    // the two files under it. A key, not a URL, because getUrl owns the domain
    // (D-07). Each upload gets a new key so the CDN never serves the old one.
    photoKey: text("photo_key"),
    sortOrder: integer("sort_order").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.restaurantId],
      foreignColumns: [restaurants.id],
    }),
    // The first key between two tenant tables. Named, because the generated name
    // is past Postgres's 63-character limit.
    foreignKey({
      name: "menu_items_category_fk",
      columns: [table.restaurantId, table.categoryId],
      foreignColumns: [categories.restaurantId, categories.id],
    }),
    unique().on(table.restaurantId, table.id),
    index().on(table.restaurantId, table.categoryId),
    check(
      "menu_items_has_a_price",
      sql`${table.priceUsd} is not null or ${table.priceZig} is not null`,
    ),
    check(
      "menu_items_prices_not_negative",
      sql`${table.priceUsd} >= 0 and ${table.priceZig} >= 0`,
    ),
    // numeric takes NaN and Infinity, and both are >= 0. NaN sorts above Infinity,
    // so this stops the two of them.
    check(
      "menu_items_prices_finite",
      sql`${table.priceUsd} < 'Infinity' and ${table.priceZig} < 'Infinity'`,
    ),
    tenantPolicy("restaurant_id"),
  ],
);

/**
 * A promotion (spec 02, Specials): an existing item at a special price, or just a
 * badge. The item's own prices never change. The window is half-open, [starts_at,
 * ends_at): a null start has no lower end and a null end runs until turned off.
 * The owner picks dates, which the app turns into instants in the restaurant's
 * timezone: a start date opens at that day's midnight, and an end date is
 * inclusive, so it closes at midnight after it.
 *
 * D-05: the exclusion constraint `specials_no_overlap` (see 0019_specials) stops
 * two active specials on one item from overlapping. Drizzle can't model it, so
 * it lives in the migration only.
 */
export const specials = pgTable(
  "specials",
  {
    id: uuid().primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id").notNull(),
    menuItemId: uuid("menu_item_id").notNull(),
    // The badge text: "Taco Tuesday".
    title: text(),
    // Null keeps the item's normal price, by the precedence in spec 00.
    specialPriceUsd: numeric("special_price_usd"),
    specialPriceZig: numeric("special_price_zig"),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    // D-04: the columns exist and nothing reads them yet.
    daysOfWeek: integer("days_of_week").array(),
    dailyStart: time("daily_start"),
    dailyEnd: time("daily_end"),
    active: boolean().notNull().default(true),
  },
  (table) => [
    foreignKey({
      columns: [table.restaurantId],
      foreignColumns: [restaurants.id],
    }),
    foreignKey({
      name: "specials_menu_item_fk",
      columns: [table.restaurantId, table.menuItemId],
      foreignColumns: [menuItems.restaurantId, menuItems.id],
    }),
    unique().on(table.restaurantId, table.id),
    index().on(table.restaurantId, table.menuItemId),
    check(
      "specials_prices_not_negative",
      sql`${table.specialPriceUsd} >= 0 and ${table.specialPriceZig} >= 0`,
    ),
    // Finite only together with the lower bound above: NaN sorts above Infinity.
    check(
      "specials_prices_finite",
      sql`${table.specialPriceUsd} < 'Infinity' and ${table.specialPriceZig} < 'Infinity'`,
    ),
    // Proposed: a special that changes nothing and says nothing is no special.
    check(
      "specials_does_something",
      sql`${table.title} is not null or ${table.specialPriceUsd} is not null or ${table.specialPriceZig} is not null`,
    ),
    // Proposed: an empty or backwards window would never be live.
    check(
      "specials_window_ordered",
      sql`${table.startsAt} is null or ${table.endsAt} is null or ${table.endsAt} > ${table.startsAt}`,
    ),
    tenantPolicy("restaurant_id"),
  ],
);

/**
 * The rate history (spec 00, 2): the current rate is the latest row, and a change
 * is a new row, never an update.
 */
export const exchangeRates = pgTable(
  "exchange_rates",
  {
    id: uuid().primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id").notNull(),
    usdToZig: numeric("usd_to_zig").notNull(),
    setBy: uuid("set_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.restaurantId],
      foreignColumns: [restaurants.id],
    }),
    foreignKey({
      name: "exchange_rates_set_by_fk",
      columns: [table.restaurantId, table.setBy],
      foreignColumns: [staff.restaurantId, staff.id],
    }),
    unique().on(table.restaurantId, table.id),
    index().on(table.restaurantId, table.createdAt),
    // > 0 alone lets NaN and Infinity through, and < 'Infinity' alone lets
    // negatives through: both together are finite and positive.
    check(
      "exchange_rates_usd_to_zig_finite",
      sql`${table.usdToZig} > 0 and ${table.usdToZig} < 'Infinity'`,
    ),
    tenantPolicy("restaurant_id"),
  ],
);

/**
 * Tables (spec 00, 3). `qr_token` is unique across the platform, so a token on
 * its own names the table and the restaurant (spec 03). Archiving frees the
 * label but the table keeps its token, which stops working (see the lookup;
 * spec 03 › Token rules records that as proposed).
 */
export const diningTables = pgTable(
  "tables",
  {
    id: uuid().primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id").notNull(),
    label: text().notNull(),
    capacity: integer().notNull(),
    // false = walk-ins only
    bookable: boolean().notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    qrToken: text("qr_token").notNull().unique(),
    tokenRotatedAt: timestamp("token_rotated_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.restaurantId],
      foreignColumns: [restaurants.id],
    }),
    unique().on(table.restaurantId, table.id),
    uniqueIndex("tables_restaurant_id_label_unique")
      .on(table.restaurantId, table.label)
      .where(sql`${table.archivedAt} is null`),
    check("tables_capacity_positive", sql`${table.capacity} > 0`),
    // 22 base62 characters is 131 bits; the minting code can't make a shorter one.
    check("tables_qr_token_shape", sql`${table.qrToken} ~ '^[0-9A-Za-z]{22,}$'`),
    tenantPolicy("restaurant_id"),
  ],
);

/**
 * Online booking settings (spec 00, 4): one row per restaurant, made by a
 * trigger when the restaurant is, with spec 00's defaults. `id` exists only
 * because every tenant table needs UNIQUE (restaurant_id, id) for composite
 * keys; the primary key is `restaurant_id`, as the spec has it *(proposed)*.
 *
 * Postgres rules that live only in the migration (0021), because Drizzle can't
 * model them:
 * - the enable gate: `enabled` can't be true unless the restaurant has a service
 *   period, a bookable live table and a contact phone
 *   (booking_settings_enable_gate), and it's switched off again if the last of
 *   those goes (booking_gate_recheck), so the gate holds at every commit;
 * - the trigger on restaurants that creates the row.
 * Every number is bounded, so the availability maths can't be handed nonsense.
 */
export const bookingSettings = pgTable(
  "booking_settings",
  {
    restaurantId: uuid("restaurant_id").primaryKey(),
    id: uuid().notNull().defaultRandom(),
    enabled: boolean().notNull().default(false),
    slotIntervalMinutes: integer("slot_interval_minutes").notNull().default(15),
    sittingMinutes: integer("sitting_minutes").notNull().default(90),
    // This size and above gets the longer sitting.
    largePartySize: integer("large_party_size").notNull().default(5),
    largePartySittingMinutes: integer("large_party_sitting_minutes").notNull().default(120),
    // Reset time between bookings on a table.
    bufferMinutes: integer("buffer_minutes").notNull().default(15),
    minLeadMinutes: integer("min_lead_minutes").notNull().default(60),
    maxDaysAhead: integer("max_days_ahead").notNull().default(30),
    maxOnlinePartySize: integer("max_online_party_size").notNull().default(8),
    guestCancelCutoffMinutes: integer("guest_cancel_cutoff_minutes").notNull().default(120),
    maxActiveBookingsPerPhone: integer("max_active_bookings_per_phone").notNull().default(2),
  },
  (table) => [
    // ON DELETE CASCADE: the row is made by the restaurant's trigger, so it
    // can't be what stops a restaurant being deleted.
    foreignKey({
      columns: [table.restaurantId],
      foreignColumns: [restaurants.id],
    }).onDelete("cascade"),
    unique().on(table.restaurantId, table.id),
    check("booking_settings_slot_interval", sql`${table.slotIntervalMinutes} between 1 and 240`),
    check("booking_settings_sitting", sql`${table.sittingMinutes} between 1 and 720`),
    check("booking_settings_large_party_size", sql`${table.largePartySize} between 1 and 100`),
    check(
      "booking_settings_large_party_sitting",
      sql`${table.largePartySittingMinutes} between 1 and 720`,
    ),
    check("booking_settings_buffer", sql`${table.bufferMinutes} between 0 and 240`),
    check("booking_settings_min_lead", sql`${table.minLeadMinutes} between 0 and 10080`),
    check("booking_settings_max_days_ahead", sql`${table.maxDaysAhead} between 0 and 365`),
    check(
      "booking_settings_max_online_party_size",
      sql`${table.maxOnlinePartySize} between 1 and 100`,
    ),
    check(
      "booking_settings_cancel_cutoff",
      sql`${table.guestCancelCutoffMinutes} between 0 and 10080`,
    ),
    check(
      "booking_settings_max_active_per_phone",
      sql`${table.maxActiveBookingsPerPhone} between 1 and 20`,
    ),
    tenantPolicy("restaurant_id"),
  ],
);

/**
 * Service periods (spec 00, 4): several per weekday, in the restaurant's local
 * wall-clock time (restaurants.timezone decides which instant that is, as the
 * availability engine converts). A period is [opens_at, closes_at), so two can
 * touch.
 *
 * The no-overlap rule is an exclusion constraint that lives only in the
 * migration (0021), because Drizzle can't model it:
 *   service_periods_no_overlap EXCLUDE USING gist (restaurant_id WITH =,
 *     weekday WITH =, int4range(opens_at secs, closes_at secs) WITH &&)
 * It leads with restaurant_id, as spec 00 has it.
 */
export const servicePeriods = pgTable(
  "service_periods",
  {
    id: uuid().primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id").notNull(),
    name: text().notNull(),
    // 0 = Sunday
    weekday: integer().notNull(),
    opensAt: time("opens_at").notNull(),
    // The latest start time a guest can book.
    lastBookingAt: time("last_booking_at").notNull(),
    // End of service; also used for the "outside hours" metric.
    closesAt: time("closes_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.restaurantId],
      foreignColumns: [restaurants.id],
    }),
    unique().on(table.restaurantId, table.id),
    check("service_periods_weekday", sql`${table.weekday} between 0 and 6`),
    check("service_periods_name", sql`trim(${table.name}) <> '' and length(${table.name}) <= 50`),
    check(
      "service_periods_times_ordered",
      sql`${table.opensAt} <= ${table.lastBookingAt} and ${table.lastBookingAt} < ${table.closesAt}`,
    ),
    // v1: periods don't cross midnight.
    check("service_periods_same_day", sql`${table.closesAt} <= '23:59'`),
    tenantPolicy("restaurant_id"),
  ],
);

/**
 * A table held for a party (spec 00, 4). Every booking has a real table: that's
 * what availability is made of.
 *
 * THE double-booking guard is an exclusion constraint that lives only in the
 * migration (0022), because Drizzle can't model it:
 *   bookings_no_overlap EXCLUDE USING gist (table_id WITH =,
 *     tstzrange(starts_at, hold_ends_at) WITH &&)
 *     WHERE (status IN ('confirmed', 'seated', 'completed'))
 * The engine's blockingStatuses (src/lib/booking-engine.ts) must match that list.
 *
 * `manage_token` is a guest's cancel link, and `guest_phone` is personal data:
 * neither goes in a log or an audit row.
 */
export const bookings = pgTable(
  "bookings",
  {
    id: uuid().primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id").notNull(),
    tableId: uuid("table_id").notNull(),
    guestName: text("guest_name").notNull(),
    // E.164. Null for a walk-in, and once the retention job has been (D-06).
    guestPhone: text("guest_phone"),
    // Whether guest_phone holds a number, so the scheduled job's purge (D-06)
    // can find the rows to null without being able to read the number itself
    // (migration 0033). Postgres computes it; nothing in the app writes it.
    guestPhoneSet: boolean("guest_phone_set")
      .notNull()
      .generatedAlwaysAs(sql`guest_phone is not null`),
    whatsappOptIn: boolean("whatsapp_opt_in").notNull(),
    partySize: integer("party_size").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    // starts_at + sitting length
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    // ends_at + buffer
    holdEndsAt: timestamp("hold_ends_at", { withTimezone: true }).notNull(),
    status: bookingStatus().notNull(),
    source: bookingSource().notNull(),
    guestNote: text("guest_note"),
    manageToken: text("manage_token").notNull().unique(),
    cancelledBy: bookingCancelledBy("cancelled_by"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.restaurantId],
      foreignColumns: [restaurants.id],
    }),
    foreignKey({
      columns: [table.restaurantId, table.tableId],
      foreignColumns: [diningTables.restaurantId, diningTables.id],
    }),
    unique().on(table.restaurantId, table.id),
    // The day list reads one restaurant's day.
    index().on(table.restaurantId, table.startsAt),
    // The scheduled job's status rules (spec 04, S-35) look across every
    // restaurant for these. Partial, so they hold only bookings still in play,
    // not every booking ever made.
    index("bookings_confirmed_ends_at_index")
      .on(table.endsAt)
      .where(sql`${table.status} = 'confirmed'`),
    index("bookings_seated_hold_ends_at_index")
      .on(table.holdEndsAt)
      .where(sql`${table.status} = 'seated'`),
    // The job's phone purge (D-06) looks across every restaurant for old bookings
    // that still hold a number. Partial, so it holds only bookings still holding
    // a number. On guest_phone_set, the column the job may read.
    index("bookings_phone_set_starts_at_index")
      .on(table.startsAt)
      .where(sql`${table.guestPhoneSet}`),
    check("bookings_guest_name", sql`trim(${table.guestName}) <> '' and length(${table.guestName}) <= 100`),
    check("bookings_guest_phone_e164", sql`${table.guestPhone} ~ '^[+][1-9][0-9]{7,14}$'`),
    check("bookings_party_size_positive", sql`${table.partySize} > 0`),
    check("bookings_guest_note_length", sql`length(${table.guestNote}) <= 200`),
    check(
      "bookings_times_ordered",
      sql`${table.startsAt} < ${table.endsAt} and ${table.endsAt} <= ${table.holdEndsAt}`,
    ),
    // The availability read looks back only this far for a hold that reaches into
    // a date (MAX_HOLD_MS in lib/bookings.ts: the largest sitting plus the largest
    // buffer, 720 + 240 minutes). The cap keeps that bound from hiding a hold.
    check("bookings_hold_capped", sql`${table.holdEndsAt} - ${table.startsAt} <= interval '960 minutes'`),
    // The same 131 bits as a table's QR token, for the same reason.
    check("bookings_manage_token_shape", sql`${table.manageToken} ~ '^[0-9A-Za-z]{22,}$'`),
    tenantPolicy("restaurant_id"),
  ],
);

/**
 * A time the restaurant is shut: a holiday, a private event (spec 00, 4). The
 * availability engine drops any sitting that runs into one, and Postgres refuses a
 * confirmed booking inside one, and a closure over a confirmed booking, whichever
 * commits first. Those two guards live only in the migration (0026), because
 * Drizzle can't model triggers: bookings_within_closure and closures_cover_bookings
 * (see migration 0026 for the lock they meet on).
 *
 * A date-only closure is local midnight to the next local midnight, converted with
 * restaurants.timezone in Postgres (src/lib/booking-closures.ts). Reads start from
 * an instant (`ends_at` is indexed after the restaurant), so no read walks the
 * closures of past years.
 */
export const closures = pgTable(
  "closures",
  {
    id: uuid().primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    reason: text(),
  },
  (table) => [
    foreignKey({
      columns: [table.restaurantId],
      foreignColumns: [restaurants.id],
    }),
    unique().on(table.restaurantId, table.id),
    index().on(table.restaurantId, table.endsAt),
    check("closures_times_ordered", sql`${table.startsAt} < ${table.endsAt}`),
    check(
      "closures_reason",
      sql`${table.reason} is null or (trim(${table.reason}) <> '' and length(${table.reason}) <= 200)`,
    ),
    tenantPolicy("restaurant_id"),
  ],
);

/**
 * A party at a table (spec 00, 6; spec 06). The first scan of a table with no
 * open session opens one and later scans join it: `table_sessions_one_open_per_table`
 * is the table lock, so two phones scanning at once can't open two. Nobody
 * approves a session (S-36), so `approved_at` is never written or read in v1; it
 * stays so approval can be added later without a schema change.
 *
 * Postgres rules that live only in the migration (0034), because Drizzle can't
 * model triggers: an order or a line can only be written while its session is
 * open (orders_session_open, order_items_session_open), and a line's prices and
 * an order's rate can't change once written (order_items_frozen,
 * orders_frozen), nor can a line move to another order or an order to another
 * session (proposed, S-40), so money can't shift between bills. app_tenant can't delete from any of the three
 * (proposed): nothing customer-facing is hard-deleted, and a void is a status.
 */
export const tableSessions = pgTable(
  "table_sessions",
  {
    id: uuid().primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id").notNull(),
    tableId: uuid("table_id").notNull(),
    status: tableSessionStatus().notNull().default("open"),
    // Unused in v1 (S-36): nothing writes or reads it.
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    // Bumped by scans, orders, item status changes and reopen (spec 06).
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // "Call a waiter" (proposed): the flag, not built yet.
    waiterRequestedAt: timestamp("waiter_requested_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closeReason: tableSessionCloseReason("close_reason"),
    // Null when the close was automatic.
    closedBy: uuid("closed_by"),
    paidCurrency: paidCurrency("paid_currency"),
  },
  (table) => [
    foreignKey({
      columns: [table.restaurantId],
      foreignColumns: [restaurants.id],
    }),
    foreignKey({
      name: "table_sessions_table_fk",
      columns: [table.restaurantId, table.tableId],
      foreignColumns: [diningTables.restaurantId, diningTables.id],
    }),
    foreignKey({
      name: "table_sessions_closed_by_fk",
      columns: [table.restaurantId, table.closedBy],
      foreignColumns: [staff.restaurantId, staff.id],
    }),
    unique().on(table.restaurantId, table.id),
    // The table lock (spec 00, 6). Opening a session is an insert that, on
    // conflict here, joins the open one instead (src/lib/ordering.ts).
    uniqueIndex("table_sessions_one_open_per_table")
      .on(table.tableId)
      .where(sql`${table.status} = 'open'`),
    tenantPolicy("restaurant_id"),
  ],
);

/**
 * One "Place order" (spec 06). The customer gives only a name. `rate_used` is the
 * restaurant's exchange rate when it was placed, frozen like the lines' prices,
 * and null while the restaurant has no rate.
 */
export const orders = pgTable(
  "orders",
  {
    id: uuid().primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    customerName: text("customer_name").notNull(),
    rateUsed: numeric("rate_used"),
    placedAt: timestamp("placed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.restaurantId],
      foreignColumns: [restaurants.id],
    }),
    foreignKey({
      name: "orders_session_fk",
      columns: [table.restaurantId, table.sessionId],
      foreignColumns: [tableSessions.restaurantId, tableSessions.id],
    }),
    unique().on(table.restaurantId, table.id),
    // A session's orders, and the order rate limit's count of its recent ones.
    index().on(table.restaurantId, table.sessionId, table.placedAt),
    // Up to 100 characters (proposed), like a booking's guest_name.
    check(
      "orders_customer_name",
      sql`trim(${table.customerName}) <> '' and length(${table.customerName}) <= 100`,
    ),
    // (proposed) A frozen rate can't give a negative ZiG price.
    check("orders_rate_used_positive", sql`${table.rateUsed} > 0`),
    // Finite only together with the > 0 above: NaN sorts above Infinity.
    check("orders_rate_used_finite", sql`${table.rateUsed} < 'Infinity'`),
    tenantPolicy("restaurant_id"),
  ],
);

/**
 * One line of an order, with its prices frozen when it was placed (spec 06):
 * changing the menu, the rate or a special later changes nothing here. A price
 * that couldn't be worked out then (no rate yet) is null, as the menu showed it,
 * and a null ZiG price has no source. `special_id` is the special live at the
 * time, for "how many did the special sell".
 */
export const orderItems = pgTable(
  "order_items",
  {
    id: uuid().primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id").notNull(),
    orderId: uuid("order_id").notNull(),
    menuItemId: uuid("menu_item_id").notNull(),
    specialId: uuid("special_id"),
    nameSnapshot: text("name_snapshot").notNull(),
    quantity: integer().notNull(),
    unitPriceUsd: numeric("unit_price_usd"),
    unitPriceZig: numeric("unit_price_zig"),
    zigSource: zigSource("zig_source"),
    note: text(),
    status: orderItemStatus().notNull().default("placed"),
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    voidReason: text("void_reason"),
    voidedBy: uuid("voided_by"),
  },
  (table) => [
    foreignKey({
      columns: [table.restaurantId],
      foreignColumns: [restaurants.id],
    }),
    foreignKey({
      name: "order_items_order_fk",
      columns: [table.restaurantId, table.orderId],
      foreignColumns: [orders.restaurantId, orders.id],
    }),
    foreignKey({
      name: "order_items_menu_item_fk",
      columns: [table.restaurantId, table.menuItemId],
      foreignColumns: [menuItems.restaurantId, menuItems.id],
    }),
    foreignKey({
      name: "order_items_special_fk",
      columns: [table.restaurantId, table.specialId],
      foreignColumns: [specials.restaurantId, specials.id],
    }),
    foreignKey({
      name: "order_items_voided_by_fk",
      columns: [table.restaurantId, table.voidedBy],
      foreignColumns: [staff.restaurantId, staff.id],
    }),
    unique().on(table.restaurantId, table.id),
    index().on(table.restaurantId, table.orderId),
    // The kitchen's lines (spec 07): only those still in play, so a load doesn't
    // read the restaurant's whole history (lines are never deleted). Placed for
    // now; #71's board filters on placed, cooking and done.
    index("order_items_in_play")
      .on(table.restaurantId, table.status)
      .where(sql`${table.status} not in ('delivered', 'voided')`),
    // 1 to 20 (proposed): the spec says only "> 0".
    check("order_items_quantity", sql`${table.quantity} between 1 and 20`),
    // Up to 200 characters (proposed), like a booking's note; blank is stored as null.
    check(
      "order_items_note",
      sql`${table.note} is null or (trim(${table.note}) <> '' and length(${table.note}) <= 200)`,
    ),
    // (proposed) A frozen price can't make a negative bill.
    check(
      "order_items_prices_not_negative",
      sql`${table.unitPriceUsd} >= 0 and ${table.unitPriceZig} >= 0`,
    ),
    // Finite only together with the lower bound above: NaN sorts above Infinity.
    check(
      "order_items_prices_finite",
      sql`${table.unitPriceUsd} < 'Infinity' and ${table.unitPriceZig} < 'Infinity'`,
    ),
    // A ZiG price says whether it was fixed or calculated, and no price has no source.
    check(
      "order_items_zig_source",
      sql`(${table.unitPriceZig} is null) = (${table.zigSource} is null)`,
    ),
    check(
      "order_items_void_recorded",
      sql`${table.status} <> 'voided' or (${table.voidReason} is not null and ${table.voidedBy} is not null)`,
    ),
    tenantPolicy("restaurant_id"),
  ],
);

/**
 * How many booking submissions one network address has made lately (spec 04,
 * abuse controls, proposed). In Postgres because memory would be per-instance on
 * Vercel, and a limit that each instance counts alone is no limit. Belongs to no
 * restaurant (the guest hasn't been resolved to one when this is spent), so it
 * gets the reverse of the tenant policy, like the sign-in tables. `key` is a
 * keyed hash of the address (src/lib/booking-limits.ts), never the address.
 */
export const bookingRateLimit = pgTable(
  "booking_rate_limit",
  {
    key: text().primaryKey(),
    attempts: integer().notNull(),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
  },
  () => [outsideTenantOnly()],
);

/**
 * Better Auth's tables, one set per session type (S-30): a staff session, link
 * or code means nothing to the platform-admin sign-in, and the other way round.
 *
 * Better Auth runs before any tenant is known, so these can't have a tenant
 * policy. They get the reverse: outsideTenantOnly. Staff sign-in connects as
 * app_staff_auth and admin sign-in as app_admin, and app_tenant holds no
 * privilege on staff_auth_* or admin_auth_* at all (S-28).
 *
 * No password column and no OAuth token columns: S-27 stores no passwords, and
 * Google is only asked who someone is (src/lib/auth).
 */
function authTables(prefix: "staff" | "admin") {
  const name = (model: string) => `${prefix}_auth_${model}`;
  const at = (column: string) => timestamp(column, { withTimezone: true });

  const user = pgTable(
    name("user"),
    {
      id: text().primaryKey(),
      name: text().notNull(),
      email: text().notNull().unique(),
      emailVerified: boolean("email_verified").notNull().default(false),
      image: text(),
      createdAt: at("created_at").notNull().defaultNow(),
      updatedAt: at("updated_at").notNull().defaultNow(),
    },
    () => [outsideTenantOnly()],
  );

  const session = pgTable(
    name("session"),
    {
      id: text().primaryKey(),
      token: text().notNull().unique(),
      userId: text("user_id")
        .notNull()
        .references(() => user.id, { onDelete: "cascade" }),
      expiresAt: at("expires_at").notNull(),
      ipAddress: text("ip_address"),
      userAgent: text("user_agent"),
      createdAt: at("created_at").notNull().defaultNow(),
      updatedAt: at("updated_at").notNull().defaultNow(),
    },
    (table) => [index().on(table.userId), outsideTenantOnly()],
  );

  const account = pgTable(
    name("account"),
    {
      id: text().primaryKey(),
      accountId: text("account_id").notNull(),
      providerId: text("provider_id").notNull(),
      userId: text("user_id")
        .notNull()
        .references(() => user.id, { onDelete: "cascade" }),
      scope: text(),
      createdAt: at("created_at").notNull().defaultNow(),
      updatedAt: at("updated_at").notNull().defaultNow(),
    },
    (table) => [
      unique().on(table.providerId, table.accountId),
      index().on(table.userId),
      outsideTenantOnly(),
    ],
  );

  const verification = pgTable(
    name("verification"),
    {
      id: text().primaryKey(),
      identifier: text().notNull(),
      value: text().notNull(),
      expiresAt: at("expires_at").notNull(),
      createdAt: at("created_at").notNull().defaultNow(),
      updatedAt: at("updated_at").notNull().defaultNow(),
    },
    (table) => [index().on(table.identifier), outsideTenantOnly()],
  );

  const rateLimit = pgTable(
    name("rate_limit"),
    {
      id: text().primaryKey(),
      key: text().notNull().unique(),
      count: integer().notNull(),
      lastRequest: bigint("last_request", { mode: "number" }).notNull(),
    },
    () => [outsideTenantOnly()],
  );

  // Not in rate_limit: Better Auth prunes that table down to its own longest
  // window, about a minute, and this counts over hours (S-30).
  const codeLimit = pgTable(
    name("code_limit"),
    {
      email: text().primaryKey(),
      attempts: integer().notNull(),
      windowStartedAt: at("window_started_at").notNull(),
    },
    () => [outsideTenantOnly()],
  );

  return { user, session, account, verification, rateLimit, codeLimit };
}

// Named exports, because drizzle-kit only looks at top-level tables.
export const {
  user: staffAuthUser,
  session: staffAuthSession,
  account: staffAuthAccount,
  verification: staffAuthVerification,
  rateLimit: staffAuthRateLimit,
  codeLimit: staffAuthCodeLimit,
} = authTables("staff");

export const {
  user: adminAuthUser,
  session: adminAuthSession,
  account: adminAuthAccount,
  verification: adminAuthVerification,
  rateLimit: adminAuthRateLimit,
  codeLimit: adminAuthCodeLimit,
} = authTables("admin");

/**
 * Which restaurant an admin session has entered (spec 01). Keyed by the session,
 * so the browser holds nothing that can choose a tenant, and a session that ends
 * takes its entry with it. Only the functions that enter and leave write it, and
 * they audit every write. A cascade isn't audited: a session ending on its own
 * means no one acted, and signing out leaves first (S-28).
 *
 * `entered_restaurant_id`, not `restaurant_id`: this isn't a tenant table. It
 * has to be read before there is a tenant, so it's outsideTenantOnly.
 */
export const adminAuthEntry = pgTable(
  "admin_auth_entry",
  {
    sessionId: text("session_id")
      .primaryKey()
      .references(() => adminAuthSession.id, { onDelete: "cascade" }),
    enteredRestaurantId: uuid("entered_restaurant_id").notNull(),
    shadowStaffId: uuid("shadow_staff_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.enteredRestaurantId, table.shadowStaffId],
      foreignColumns: [staff.restaurantId, staff.id],
    }).onDelete("cascade"),
    outsideTenantOnly(),
  ],
);
