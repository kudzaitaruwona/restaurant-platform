import { eq, sql, type SQL } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  openAdminDatabase,
  openOwnerDatabase,
  openTestDatabase,
} from "../../test/integration/database";
import { devPlatformAdmin, devRestaurants } from "../lib/tenant/dev-identities";
import { aBooking, bookableRestaurant } from "../../test/integration/bookings";
import { auditLog, bookings, restaurants, staff } from "./schema";

/**
 * The privileged path (S-28), driven the way the app drives it: as app_admin,
 * which can reach these rows through nothing else. The app-layer guard is
 * tested in access.int.test.ts, and what app_tenant can't do in
 * admin-role.int.test.ts; this is what holds without either.
 */
const app = openAdminDatabase();
const owner = openOwnerDatabase();
const tenantRole = openTestDatabase();

const SLUG_PREFIX = "fn-test-";
const adminId: string = devPlatformAdmin.platformAdminId;
const [restaurantA] = devRestaurants.map((restaurant) => restaurant.id);

const INSUFFICIENT_PRIVILEGE = "42501";
const UNIQUE_VIOLATION = "23505";
const INVALID_PARAMETER = "22023";
const NO_DATA_FOUND = "P0002";
const ALREADY_HAS_STAFF = "PA001";

afterAll(async () => {
  // Restaurants created here stay behind: one with an owner can't lose it (S-26).
  await Promise.all([app.pool.end(), owner.pool.end(), tenantRole.pool.end()]);
});

const slug = () => `${SLUG_PREFIX}${crypto.randomUUID()}`;
const email = () => `${crypto.randomUUID()}@example.test`;

const createRestaurantSql = (name: string, newSlug: string, actor = adminId, timezone = "Africa/Harare") =>
  sql`select platform_create_restaurant(${actor}, ${name}, ${newSlug}, ${timezone}, 'usd_only') as id`;

const createOwnerSql = (restaurantId: string, ownerEmail: string, actor = adminId) =>
  sql`select platform_create_first_owner(${actor}, ${restaurantId}, ${ownerEmail}, 'First Owner') as id`;

const idFrom = async (query: SQL) => {
  const { rows } = await app.db.execute(query);
  return (rows[0] as { id: string }).id;
};

const newRestaurant = () => idFrom(createRestaurantSql("Test", slug()));

const asTenant = (restaurantId: string, query: SQL) =>
  app.db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.restaurant_id', ${restaurantId}, true)`,
    );
    return tx.execute(query);
  });

const failsWith = (call: Promise<unknown>, code: string) =>
  expect(call).rejects.toMatchObject({ cause: { code } });

const staffOf = (restaurantId: string) =>
  owner.db.select().from(staff).where(eq(staff.restaurantId, restaurantId));
const auditOf = (restaurantId: string) =>
  owner.db.select().from(auditLog).where(eq(auditLog.restaurantId, restaurantId));

describe("platform_create_restaurant", () => {
  it("creates the restaurant, with a menu token of its own, and audits it", async () => {
    const newSlug = slug();
    const id = await idFrom(createRestaurantSql("Mama's", newSlug));

    const [row] = await owner.db
      .select()
      .from(restaurants)
      .where(eq(restaurants.id, id));
    expect(row).toMatchObject({
      name: "Mama's",
      slug: newSlug,
      timezone: "Africa/Harare",
      currencyMode: "usd_only",
    });
    expect(row.menuToken).toMatch(/^[0-9a-f]{32}$/);

    expect(await auditOf(id)).toMatchObject([
      {
        actorType: "platform_admin",
        actorId: adminId,
        action: "restaurant.create",
        entityType: "restaurant",
        entityId: id,
      },
    ]);
  });

  it("refuses a slug that's taken", async () => {
    const taken = slug();
    await idFrom(createRestaurantSql("First", taken));
    await failsWith(
      app.db.execute(createRestaurantSql("Second", taken)),
      UNIQUE_VIOLATION,
    );
  });

  it.each(["Mars/Olympus", "+02:00", ""])(
    "refuses a timezone Postgres doesn't know: %j",
    async (timezone) => {
      await failsWith(
        app.db.execute(createRestaurantSql("Test", slug(), adminId, timezone)),
        INVALID_PARAMETER,
      );
    },
  );
});

describe("platform_create_first_owner", () => {
  it("creates an owner and audits it as the platform admin, in that restaurant", async () => {
    const restaurantId = await newRestaurant();
    const ownerEmail = email();

    const id = await idFrom(createOwnerSql(restaurantId, ownerEmail));

    expect(await staffOf(restaurantId)).toMatchObject([
      {
        id,
        email: ownerEmail,
        displayName: "First Owner",
        role: "owner",
        kind: "staff",
        active: true,
      },
    ]);
    const entries = await auditOf(restaurantId);
    expect(entries.find(({ action }) => action === "staff.create")).toMatchObject({
      actorType: "platform_admin",
      actorId: adminId,
      entityType: "staff",
      entityId: id,
      details: { role: "owner" },
    });
  });

  it("only ever makes the first: a restaurant with staff is refused", async () => {
    const restaurantId = await newRestaurant();
    await idFrom(createOwnerSql(restaurantId, email()));

    await failsWith(
      app.db.execute(createOwnerSql(restaurantId, email())),
      ALREADY_HAS_STAFF,
    );
    expect(await staffOf(restaurantId)).toHaveLength(1);
  });

  it("can't plant an owner in an onboarded restaurant, even with a real admin id", async () => {
    await failsWith(
      app.db.execute(createOwnerSql(restaurantA, email())),
      ALREADY_HAS_STAFF,
    );
  });

  it("makes exactly one owner from two submissions at once", async () => {
    const restaurantId = await newRestaurant();

    const results = await Promise.allSettled([
      idFrom(createOwnerSql(restaurantId, email())),
      idFrom(createOwnerSql(restaurantId, email())),
    ]);

    expect(results.map(({ status }) => status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(await staffOf(restaurantId)).toHaveLength(1);
  });

  it("isn't blocked by the admin's shadow row, which is no staff member (spec 00)", async () => {
    const restaurantId = await newRestaurant();
    await owner.db.insert(staff).values({
      restaurantId,
      kind: "platform_admin",
      displayName: "Shadow",
      role: "owner",
    });

    await idFrom(createOwnerSql(restaurantId, email()));

    expect(await staffOf(restaurantId)).toHaveLength(2);
  });

  it("refuses a restaurant that doesn't exist", async () => {
    await failsWith(
      app.db.execute(createOwnerSql(crypto.randomUUID(), email())),
      NO_DATA_FOUND,
    );
  });

  it("refuses an email already in use, leaving no staff row and no audit entry", async () => {
    const taken = email();
    await idFrom(createOwnerSql(await newRestaurant(), taken));
    const restaurantId = await newRestaurant();

    await failsWith(
      app.db.execute(createOwnerSql(restaurantId, taken)),
      UNIQUE_VIOLATION,
    );

    expect(await staffOf(restaurantId)).toEqual([]);
    expect(
      (await auditOf(restaurantId)).map(({ action }) => action),
    ).toEqual(["restaurant.create"]);
  });
});

describe("platform_list_restaurants", () => {
  const listSql = (actor = adminId) => sql`select * from platform_list_restaurants(${actor})`;

  it("shows every restaurant, whether it has an owner yet, and no secrets", async () => {
    const waiting = await newRestaurant();
    const onboarded = await newRestaurant();
    await idFrom(createOwnerSql(onboarded, email()));

    const { rows } = await app.db.execute(listSql());
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get(waiting)).toMatchObject({ has_owner: false });
    expect(byId.get(onboarded)).toMatchObject({ has_owner: true });
    expect(byId.get(restaurantA)).toMatchObject({
      name: "Restaurant A",
      has_owner: true,
    });
    expect(Object.keys(rows[0]).sort()).toEqual([
      "currency_mode",
      "has_owner",
      "id",
      "name",
      "slug",
      "timezone",
    ]);
  });

  it("doesn't count the admin's shadow row as an owner", async () => {
    const restaurantId = await newRestaurant();
    await owner.db.insert(staff).values({
      restaurantId,
      kind: "platform_admin",
      displayName: "Shadow",
      role: "owner",
    });

    const { rows } = await app.db.execute(listSql());

    expect(rows.find(({ id }) => id === restaurantId)).toMatchObject({
      has_owner: false,
    });
  });
});

describe("platform_list_booking_metrics", () => {
  it("gives every restaurant's counts, the same ones the restaurant's own function gives", async () => {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, {
      tables: [{ capacity: 2 }, { capacity: 2 }, { capacity: 2 }],
    });
    const starts = "2027-01-10T16:00:00Z";
    const ends = "2027-01-10T17:45:00Z";
    await owner.db.insert(bookings).values([
      // 03:00 UTC is 05:00 in Harare, before dinner: made while staff weren't answering.
      { ...aBooking(restaurantId, tableIds[0], starts, ends), createdAt: new Date("2026-11-05T03:00:00Z"), status: "no_show" as const },
      { ...aBooking(restaurantId, tableIds[1], starts, ends), createdAt: new Date("2026-11-05T17:00:00Z"), status: "completed" as const },
      { ...aBooking(restaurantId, tableIds[2], starts, ends), source: "staff" as const },
    ]);

    const { rows } = await app.db.execute<{
      restaurant_id: string;
      online: number;
      staff: number;
      outside_hours: number;
      no_shows: number;
      attended: number;
    }>(sql`select * from platform_list_booking_metrics(${adminId})`);
    const { online, staff: byStaff, outside_hours, no_shows, attended } = rows.find(
      (row) => row.restaurant_id === restaurantId,
    )!;
    const counts = { online, staff: byStaff, outside_hours, no_shows, attended };
    // As the restaurant itself reads it: app_tenant, inside its tenant.
    const own = await tenantRole.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.restaurant_id', ${restaurantId}, true)`);
      return tx.execute(sql`select * from booking_success_metrics(${restaurantId})`);
    });

    expect(counts).toEqual({ online: 2, staff: 1, outside_hours: 1, no_shows: 1, attended: 2 });
    expect(own.rows).toEqual([counts]);
    expect(rows.map((row) => row.restaurant_id)).toEqual(
      expect.arrayContaining([restaurantId, restaurantA]),
    );
  });
});

describe("who can reach the functions", () => {
  const calls = (restaurantId: string, actor: string) => [
    createRestaurantSql("Refused", slug(), actor),
    createOwnerSql(restaurantId, email(), actor),
    sql`select * from platform_list_restaurants(${actor})`,
    sql`select * from platform_list_booking_metrics(${actor})`,
    sql`select platform_enter_restaurant(${actor}, ${"no-such-session"}, ${restaurantId})`,
    sql`select platform_leave_restaurant(${actor}, ${"no-such-session"})`,
    sql`select * from platform_onboarding_checklist(${actor})`,
    sql`select platform_set_qr_codes_printed(${actor}, ${restaurantId}, true)`,
  ];

  it("an id that isn't a platform admin's gets nothing", async () => {
    const restaurantId = await newRestaurant();
    for (const call of calls(restaurantId, crypto.randomUUID())) {
      await failsWith(app.db.execute(call), INSUFFICIENT_PRIVILEGE);
    }
    expect(await staffOf(restaurantId)).toEqual([]);
  });

  it("nothing inside a tenant transaction gets through, even with a real admin id", async () => {
    const restaurantId = await newRestaurant();
    for (const call of calls(restaurantId, adminId)) {
      await failsWith(asTenant(restaurantA, call), INSUFFICIENT_PRIVILEGE);
    }
    expect(await staffOf(restaurantId)).toEqual([]);
  });

  it("works on a pooled connection a tenant has just used", async () => {
    const client = await app.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `select set_config('app.restaurant_id', '${restaurantA}', true)`,
      );
      await client.query("commit");
      const { rows } = await client.query(
        "select count(*) from platform_list_restaurants($1)",
        [adminId],
      );
      expect(Number(rows[0].count)).toBeGreaterThan(0);
    } finally {
      client.release();
    }
  });

  it("the admin login can't call the admin check on its own", async () => {
    await failsWith(
      app.db.execute(sql`select platform_assert_admin(${adminId})`),
      INSUFFICIENT_PRIVILEGE,
    );
  });
});

describe("every SECURITY DEFINER function", () => {
  const definers = async () => {
    const { rows } = await owner.db.execute<{
      name: string;
      config: string[] | null;
      isTrigger: boolean;
      executors: string[];
    }>(sql`
      select p.proname as name,
             p.proconfig as config,
             p.prorettype = 'trigger'::regtype as "isTrigger",
             array(
               select case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end
               from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
               where a.privilege_type = 'EXECUTE' and a.grantee <> p.proowner
             ) as executors
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef
    `);
    return rows;
  };

  it("exists, so this suite tests something", async () => {
    expect((await definers()).map(({ name }) => name).sort()).toEqual(
      expect.arrayContaining([
        "end_staff_sessions",
        "platform_admin_id_by_email",
        "platform_create_first_owner",
        "platform_create_restaurant",
        "platform_enter_restaurant",
        "platform_leave_restaurant",
        "platform_list_booking_metrics",
        "platform_list_restaurants",
        "platform_onboarding_checklist",
        "platform_finish_invite",
        "platform_list_owners",
        "platform_set_qr_codes_printed",
        "platform_start_owner_invite",
        "staff_identity_by_email",
        "staff_keep_last_owner",
        "staff_record_first_sign_in",
      ]),
    );
  });

  it("pins search_path and can be run by exactly one role", async () => {
    for (const { name, config, isTrigger, executors } of await definers()) {
      expect(config, name).toContain("search_path=pg_catalog, pg_temp");
      // A trigger needs no EXECUTE grant, so nobody at all should hold one.
      const runner = name.startsWith("platform_")
        ? "app_admin"
        : name === "staff_identity_by_email" || name === "staff_record_first_sign_in"
          ? "app_staff_auth"
          : "app_tenant";
      expect(executors, name).toEqual(isTrigger ? [] : [runner]);
    }
  });
});
