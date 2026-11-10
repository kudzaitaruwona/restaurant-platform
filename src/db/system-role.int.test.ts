import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { aBooking, bookableRestaurant } from "../../test/integration/bookings";
import {
  openAdminDatabase,
  openOwnerDatabase,
  openStaffAuthDatabase,
  openSystemDatabase,
  openTestDatabase,
  ownerDatabaseSettings,
  systemDatabaseSettings,
  testDatabaseSettings,
} from "../../test/integration/database";
import { SYSTEM_DATABASE_ROLE } from "../lib/env";
import { provisionSystemRole } from "./app-role";
import { bookings, notifications } from "./schema";

/**
 * The scheduled job's login (spec 01, S-28, S-35), proved from Postgres itself.
 * It works across every tenant, so it has BYPASSRLS, and that is why it is
 * granted only the columns the job reads and writes: the job's status rules,
 * its audit entries, the sign-in code rows it prunes, and D-06's phone purge:
 * whether a booking still holds a phone (guest_phone_set, never the number) and
 * a restaurant's timezone to read, and guest_phone to write. A column grant can't
 * say "only to null", so a trigger (migration 0033) refuses any other value it
 * writes there. No guest's name or number, no other tenant table, no credential.
 * Spec 05's outbox: it claims and finishes notifications, and reads a guest's
 * name, number and manage link only through notification_sends, for a
 * notification it has claimed (migration 0034).
 */
const system = openSystemDatabase();
const owner = openOwnerDatabase();
const others = {
  app_tenant: openTestDatabase(),
  app_admin: openAdminDatabase(),
  app_staff_auth: openStaffAuthDatabase(),
};
afterAll(() =>
  Promise.all([system, owner, ...Object.values(others)].map(({ pool }) => pool.end())),
);

const INSUFFICIENT_PRIVILEGE = "42501";
const refused = { cause: { code: INSUFFICIENT_PRIVILEGE } };

/** Every privilege app_system holds on a table in public, by table and column. */
async function grantsOf(role: string) {
  const { rows } = await owner.db.execute<{ grant: string }>(sql`
    select c.relname || ': ' || p.privilege as grant
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p(privilege)
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v')
      and has_table_privilege(${role}, c.oid, p.privilege)
    union all
    select c.relname || '.' || a.attname || ': ' || p.privilege
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) as p(privilege)
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v')
      and not has_table_privilege(${role}, c.oid, p.privilege)
      and has_column_privilege(${role}, c.oid, a.attnum, p.privilege)
    order by 1
  `);
  return rows.map(({ grant }) => grant);
}

describe("app_system", () => {
  it("is a login that bypasses RLS and can do nothing else a superuser can", async () => {
    const { rows } = await system.db.execute(sql`
      select rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication
      from pg_roles where rolname = current_user
    `);
    expect(rows).toEqual([
      {
        rolname: SYSTEM_DATABASE_ROLE,
        rolsuper: false,
        rolbypassrls: true,
        rolcreaterole: false,
        rolcreatedb: false,
        rolcanlogin: true,
        rolreplication: false,
      },
    ]);
  });

  it("owns nothing", async () => {
    const { rows } = await system.db.execute(sql`
      select c.relname from pg_class c where pg_get_userbyid(c.relowner) = current_user
    `);
    expect(rows).toEqual([]);
  });

  it("holds exactly what the job needs, column by column", async () => {
    expect(await grantsOf(SYSTEM_DATABASE_ROLE)).toEqual([
      "admin_auth_code_limit.window_started_at: SELECT",
      "admin_auth_code_limit: DELETE",
      "audit_log.action: INSERT",
      "audit_log.actor_id: INSERT",
      "audit_log.actor_type: INSERT",
      "audit_log.details: INSERT",
      "audit_log.entity_id: INSERT",
      "audit_log.entity_type: INSERT",
      "audit_log.restaurant_id: INSERT",
      "booking_settings.buffer_minutes: SELECT",
      "booking_settings.restaurant_id: SELECT",
      "bookings.ends_at: SELECT",
      "bookings.ends_at: UPDATE",
      "bookings.guest_phone: UPDATE",
      "bookings.guest_phone_set: SELECT",
      "bookings.hold_ends_at: SELECT",
      "bookings.hold_ends_at: UPDATE",
      "bookings.id: SELECT",
      "bookings.restaurant_id: SELECT",
      "bookings.starts_at: SELECT",
      "bookings.status: SELECT",
      "bookings.status: UPDATE",
      "bookings.table_id: SELECT",
      "notification_sends: SELECT",
      "notifications.attempts: SELECT",
      "notifications.attempts: UPDATE",
      "notifications.claimed_at: UPDATE",
      "notifications.id: SELECT",
      "notifications.kind: SELECT",
      "notifications.last_error: UPDATE",
      "notifications.provider_message_id: UPDATE",
      "notifications.restaurant_id: SELECT",
      "notifications.scheduled_for: SELECT",
      "notifications.status: SELECT",
      "notifications.status: UPDATE",
      "restaurants.id: SELECT",
      "restaurants.timezone: SELECT",
      "staff_auth_code_limit.window_started_at: SELECT",
      "staff_auth_code_limit: DELETE",
    ]);
  });

  it("can't read a guest's name, number or manage link, the restaurant's other columns, or any other tenant table", async () => {
    for (const query of [
      sql`select guest_name from bookings limit 1`,
      sql`select guest_phone from bookings limit 1`,
      sql`select id from bookings where guest_phone like '+263%' limit 1`,
      sql`select whatsapp_opt_in from bookings limit 1`,
      sql`select manage_token from bookings limit 1`,
      sql`select * from staff limit 1`,
      sql`select * from restaurants limit 1`,
      sql`select wifi_password from restaurants limit 1`,
      sql`select contact_phone from restaurants limit 1`,
      sql`select action from audit_log limit 1`,
      sql`select email from staff_auth_code_limit limit 1`,
      sql`select * from staff_auth_verification limit 1`,
    ]) {
      await expect(system.db.execute(query)).rejects.toMatchObject(refused);
    }
  });

  it("can't rewrite or erase history", async () => {
    for (const query of [
      sql`update bookings set table_id = table_id where false`,
      sql`update bookings set guest_name = '' where false`,
      sql`update bookings set manage_token = '' where false`,
      sql`update restaurants set timezone = timezone where false`,
      sql`delete from bookings where false`,
      sql`update audit_log set action = action where false`,
      sql`delete from audit_log where false`,
    ]) {
      await expect(system.db.execute(query)).rejects.toMatchObject(refused);
    }
  });

  describe("a guest's phone, the one personal column it may change (D-06)", () => {
    const PHONE = "+263771234567";
    /** A real upcoming booking with a phone, in a restaurant of its own. */
    async function aBookingWithPhone() {
      const { restaurantId, tableIds } = await bookableRestaurant(owner.db, { tables: [{ capacity: 2 }] });
      const [{ id }] = await owner.db
        .insert(bookings)
        .values({ ...aBooking(restaurantId, tableIds[0], "2099-05-02T17:00:00Z", "2099-05-02T19:00:00Z"), guestPhone: PHONE })
        .returning({ id: bookings.id });
      return { restaurantId, id };
    }
    const phoneOf = async (id: string) =>
      (await owner.db.select({ phone: bookings.guestPhone }).from(bookings).where(eq(bookings.id, id)))[0].phone;

    it("can be nulled, found by guest_phone_set without reading the number", async () => {
      const { restaurantId, id } = await aBookingWithPhone();
      const { rowCount } = await system.db.execute(
        sql`update bookings set guest_phone = null where restaurant_id = ${restaurantId} and id = ${id} and guest_phone_set`,
      );
      expect(rowCount).toBe(1);
      expect(await phoneOf(id)).toBeNull();
    });

    it("can't be set to another number: the trigger refuses it, though the column grant allows it", async () => {
      const { restaurantId, id } = await aBookingWithPhone();
      await expect(
        system.db.execute(
          sql`update bookings set guest_phone = '+263779999999' where restaurant_id = ${restaurantId} and id = ${id}`,
        ),
      ).rejects.toMatchObject(refused);
      expect(await phoneOf(id)).toBe(PHONE);
    });
  });

  describe("the outbox (spec 05)", () => {
    /** A booking with a phone and its booking_confirmed row, in a restaurant of its own. */
    async function aQueuedBooking() {
      const { restaurantId, tableIds } = await bookableRestaurant(owner.db, { tables: [{ capacity: 2 }] });
      const [{ id: bookingId }] = await owner.db
        .insert(bookings)
        .values({ ...aBooking(restaurantId, tableIds[0], "2099-06-02T17:00:00Z", "2099-06-02T19:00:00Z"), guestPhone: "+263771234567" })
        .returning({ id: bookings.id });
      const [{ id }] = await owner.db
        .insert(notifications)
        .values({ restaurantId, bookingId, kind: "booking_confirmed", scheduledFor: new Date("2099-01-01T00:00:00Z") })
        .returning({ id: notifications.id });
      return { restaurantId, bookingId, id };
    }
    const sendsFor = (id: string) =>
      system.db.execute(sql`select guest_name, guest_phone, manage_token from notification_sends where id = ${id}`);

    it("reads a guest's details through notification_sends only once it has claimed the notification", async () => {
      const { restaurantId, id } = await aQueuedBooking();
      expect((await sendsFor(id)).rows).toEqual([]);

      await system.db.execute(
        sql`update notifications set status = 'sending', claimed_at = now() where restaurant_id = ${restaurantId} and id = ${id}`,
      );
      expect((await sendsFor(id)).rows).toEqual([
        { guest_name: "Fixture guest", guest_phone: "+263771234567", manage_token: expect.any(String) },
      ]);

      await system.db.execute(
        sql`update notifications set status = 'sent' where restaurant_id = ${restaurantId} and id = ${id}`,
      );
      expect((await sendsFor(id)).rows).toEqual([]);
    });

    it("can't queue a notification, move one to another booking, or delete one", async () => {
      const { restaurantId, bookingId, id } = await aQueuedBooking();
      for (const query of [
        sql`insert into notifications (restaurant_id, booking_id, kind, scheduled_for) values (${restaurantId}, ${bookingId}, 'booking_reminder', now())`,
        sql`update notifications set booking_id = booking_id where id = ${id}`,
        sql`update notifications set scheduled_for = now() where id = ${id}`,
        sql`delete from notifications where id = ${id}`,
      ]) {
        await expect(system.db.execute(query)).rejects.toMatchObject(refused);
      }
    });
  });

  it("can run no function that bypasses RLS", async () => {
    const { rows } = await owner.db.execute<{ name: string }>(sql`
      select p.proname as name from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef
        and has_function_privilege(${SYSTEM_DATABASE_ROLE}, p.oid, 'execute')
    `);
    expect(rows).toEqual([]);
  });

  it.each(Object.keys(others))("can't become %s, nor it app_system", async (other) => {
    const { rows } = await owner.db.execute(sql`
      select pg_has_role(${SYSTEM_DATABASE_ROLE}, ${other}, 'member') as up,
             pg_has_role(${other}, ${SYSTEM_DATABASE_ROLE}, 'member') as down
    `);
    expect(rows).toEqual([{ up: false, down: false }]);
    await expect(
      others[other as keyof typeof others].db.transaction((tx) =>
        tx.execute(sql.raw(`set local role ${SYSTEM_DATABASE_ROLE}`)),
      ),
    ).rejects.toMatchObject(refused);
  });
});

describe("provisionSystemRole", () => {
  it("is safe to run again, leaving it able to log in", async () => {
    await provisionSystemRole(ownerDatabaseSettings(), systemDatabaseSettings().connectionString);
    const { rows } = await system.db.execute(sql`select current_user as name`);
    expect(rows).toEqual([{ name: SYSTEM_DATABASE_ROLE }]);
  });

  it("refuses another role's URL: it takes the password from its own", async () => {
    await expect(
      provisionSystemRole(ownerDatabaseSettings(), testDatabaseSettings().connectionString),
    ).rejects.toThrow(/must log in as app_system/);
  });
});

describe("provisionSystemRole on a role that isn't what the migration made", () => {
  // Roles are per cluster, so these use throwaway roles, never the shared one.
  const probe = `probe_system_${crypto.randomUUID().slice(0, 8)}`;
  const run = (statement: string) => owner.db.execute(sql.raw(statement));
  const provisionProbe = () =>
    provisionSystemRole(ownerDatabaseSettings(), `postgres://${probe}:probe-password@host/db`, probe);
  afterEach(() => run(`drop role if exists ${probe}`));

  it("refuses one without BYPASSRLS: the job would quietly see no rows", async () => {
    await run(`create role ${probe} nologin nobypassrls`);
    await expect(provisionProbe()).rejects.toThrow(/BYPASSRLS/);
  });

  it("refuses a superuser", async () => {
    await run(`create role ${probe} nologin superuser`);
    await expect(provisionProbe()).rejects.toThrow(/superuser/);
  });

  it("refuses one that can create roles or databases", async () => {
    await run(`create role ${probe} nologin bypassrls createrole`);
    await expect(provisionProbe()).rejects.toThrow(/CREATEROLE/);
  });

  it("refuses one that belongs to another role, whose grants it would carry", async () => {
    await run(`create role ${probe} nologin bypassrls`);
    await run(`grant app_tenant to ${probe}`);
    await expect(provisionProbe()).rejects.toThrow(/app_tenant/);
  });

  it("accepts one made the way the migration makes it", async () => {
    await run(`create role ${probe} nologin bypassrls nocreaterole nocreatedb`);
    await expect(provisionProbe()).resolves.toBeUndefined();
  });
});
