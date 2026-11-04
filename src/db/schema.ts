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
 * The menu (spec 00, 2). Columns arrive with the tickets that use them: photos,
 * availability, visibility and archiving aren't here yet.
 */
export const categories = pgTable(
  "categories",
  {
    id: uuid().primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id").notNull(),
    name: text().notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
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
    sortOrder: integer("sort_order").notNull().default(0),
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
 * Better Auth's tables, one set per session type (S-30): a staff session, link
 * or code means nothing to the platform-admin sign-in, and the other way round.
 *
 * Better Auth runs before any tenant is known, so these can't have a tenant
 * policy. They get the reverse: outsideTenantOnly. Staff sign-in connects as
 * app_tenant. Admin sign-in connects as app_admin, and app_tenant holds no
 * privilege on admin_auth_* at all (S-28).
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
