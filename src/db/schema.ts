import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  numeric,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
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

export const currencyMode = pgEnum("currency_mode", [
  "usd_only",
  "zig_only",
  "usd_primary",
  "zig_primary",
  "both",
]);

export const staffKind = pgEnum("staff_kind", ["staff", "platform_admin"]);

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
  () => [tenantPolicy("id")],
);

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
    check(
      "staff_email_required",
      sql`${table.kind} = 'platform_admin' or ${table.email} is not null`,
    ),
    tenantPolicy("restaurant_id"),
  ],
);
