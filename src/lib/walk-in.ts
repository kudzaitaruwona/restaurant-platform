import "server-only";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { bookingHref } from "@/lib/booking-closures";
import { blockingStatuses, dateLabel, localToday, localTime } from "@/lib/booking-engine";
import { mintQrToken } from "@/lib/qr-token";
import { recordAdminAction } from "@/lib/tenant/audit";
import { type TenantContext, withTenant } from "@/lib/tenant/scope";

/**
 * Seat a walk-in (spec 04 › Staff actions). Owners and staff both (S-26), so
 * nothing here checks the role; the restaurant comes from the context, the table
 * from the request and is looked up inside that restaurant only.
 */

type Actor = Pick<TenantContext, "restaurantId" | "staffId" | "platformAdminId">;

/** A walk-in needs at least this long before the next booking's reset buffer starts (spec 04). */
export const WALK_IN_MIN_MINUTES = 30;
/** *(Proposed)* A sanity bound on the party size; booking_settings allows a large-party size of up to 100. */
export const WALK_IN_MAX_PARTY = 100;

const messages = {
  table: "Choose a table.",
  party: `Enter a party size from 1 to ${WALK_IN_MAX_PARTY}.`,
};

/** The form: a malformed table id is a 404 like any unknown one, so it is read apart from the party. */
export function parseWalkIn(form: FormData) {
  const party = z
    .string(messages.party)
    .regex(/^[0-9]{1,3}$/, messages.party)
    .transform(Number)
    .refine((value) => value >= 1 && value <= WALK_IN_MAX_PARTY, messages.party)
    .safeParse(form.get("party"));
  const tableId = z.uuid().safeParse(form.get("tableId"));
  return { party, tableId };
}

export type WalkInOutcome =
  | { outcome: "seated"; bookingId: string; endsAt: Date; holdEndsAt: Date }
  | { outcome: "not_found" }
  | { outcome: "table_archived"; table: string }
  /**
   * Someone is at the table now, or its reset buffer runs on: `freeAt` is when it
   * frees, `resetting` says it is the buffer after a finish, and `booking` is the
   * one holding it (its own day view row).
   */
  | { outcome: "table_occupied"; table: string; freeAt: string; resetting: boolean; booking: WalkInBooking }
  /** Under 30 minutes before the next booking: `at` is that booking's start. */
  | { outcome: "booking_soon"; table: string; at: string; booking: WalkInBooking }
  /** A guest's confirm or an owner's edit won the table between the read and the insert. */
  | { outcome: "table_taken" };

/** The booking in the way of a walk-in: where staff find it, and what it is, without a phone. */
export type WalkInBooking = { id: string; href: string; guestName: string; partySize: number; time: string; day: string };

type Calculated = {
  label: string;
  archived: boolean;
  timezone: string;
  busy_ms: number | null;
  next_ms: number | null;
  busy_id: string | null;
  busy_resetting: boolean | null;
  busy_name: string | null;
  busy_party: number | null;
  busy_start_ms: number | null;
  next_id: string | null;
  next_name: string | null;
  next_party: number | null;
  ok: boolean;
  id: string | null;
  ends_ms: number | null;
  hold_ms: number | null;
};

/**
 * The two reads both the seating statement and the availability list make about a
 * table, so what the list promises is what the statement enforces. Each is a
 * lateral join over `ctx` (table_id, n, restaurant_id), bounded by the table and
 * the restaurant, reading the index on (restaurant_id, starts_at).
 *
 *  - held: the blocking booking holding the table at n with the latest hold.
 *    bookings_hold_capped keeps a hold within 960 minutes of its start, so nothing
 *    that started earlier can still hold the table. Raising that cap means raising
 *    this bound too. `resetting` is the buffer after a finish: the party is gone
 *    (completed, ends_at passed) and only the reset buffer holds the table.
 *  - upcoming: the earliest blocking booking starting after n.
 */
const blocking = sql.join(
  blockingStatuses.map((status) => sql`${status}`),
  sql`, `,
);
const minute = sql`interval '1 minute'`;
const heldNow = sql`left join lateral (
  select b.id as busy_id, b.guest_name as busy_name, b.party_size as busy_party,
    b.starts_at as busy_starts, b.hold_ends_at as busy_hold,
    (b.status = 'completed' and b.ends_at <= ctx.n) as busy_resetting
  from bookings b
  where b.restaurant_id = ctx.restaurant_id and b.table_id = ctx.table_id
    and b.status in (${blocking}) and b.starts_at <= ctx.n and b.hold_ends_at > ctx.n
    and b.starts_at > ctx.n - 960 * ${minute}
  order by b.hold_ends_at desc, b.id
  limit 1) held on true`;
const upcoming = sql`left join lateral (
  select b.id as next_id, b.guest_name as next_name, b.party_size as next_party, b.starts_at as next_starts
  from bookings b
  where b.restaurant_id = ctx.restaurant_id and b.table_id = ctx.table_id
    and b.status in (${blocking}) and b.starts_at > ctx.n
  order by b.starts_at, b.id
  limit 1) upcoming on true`;
/** When a walk-in must be gone: the next booking's start less the reset buffer (null with none). */
const roomEnds = sql`(upcoming.next_starts - ctx.buffer)`;
/** The table takes a walk-in now: nobody holds it, and there are at least 30 minutes of room. */
const takesWalkIn = sql`(held.busy_id is null and (upcoming.next_id is null
  or ${roomEnds} - ctx.n >= ${WALK_IN_MIN_MINUTES} * ${minute}))`;

const bookingOf = (
  id: string | null,
  name: string | null,
  party: number | null,
  startMs: number | null,
  timezone: string,
): WalkInBooking => {
  const starts = new Date(Number(startMs));
  return {
    id: id as string,
    href: bookingHref(id as string, localToday(starts, timezone)),
    guestName: name as string,
    partySize: party as number,
    time: localTime(starts, timezone),
    day: dateLabel(localToday(starts, timezone)),
  };
};

/**
 * One statement reads the clock, the table's sitting length and buffer, whoever
 * holds the table now and the next booking on it, and inserts the walk-in if it
 * fits, so none of them can move between the check and the insert. `now` is the
 * database's own now() (the transaction's start) unless a test passes one.
 *
 *  - "Next booking" is the earliest booking on the table that starts after now
 *    and is in a blocking status (the exclusion constraint's WHERE), so a
 *    cancelled or no-show booking never blocks a walk-in.
 *  - sitting is the table's real one by party size (booking_settings).
 *  - ends_at = least(now + sitting, next - buffer); hold_ends_at = ends_at +
 *    buffer. The hold therefore ends at or before the next booking's start and
 *    can't overlap it (the range is half-open); it stays within 960 minutes
 *    (sitting <= 720, buffer <= 240).
 *  - The 30-minute floor is on the room before the next booking's buffer, not on
 *    the sitting: next - buffer - now < 30 minutes is refused. A short sitting
 *    (booking_settings allows 1 minute) can then still be seated when nothing
 *    is booked, and with buffer_minutes = 15 a booking at 19:00 refuses a
 *    walk-in after 18:15. Exactly 30 minutes is seated.
 *  - A table held now (a seated or running-late party, or the buffer after a
 *    finish) can't take another, since the hold would overlap: refused before
 *    the floor, with when it frees.
 *  - The exclusion constraint is still the guard. A booking that commits between
 *    the read and the insert makes the insert fail with 23P01, answered as
 *    table_taken; two walk-ins, or a walk-in and a confirm, get one winner.
 */
export async function seatWalkIn(
  actor: Actor,
  tableId: string,
  party: number,
  now?: Date,
): Promise<WalkInOutcome> {
  const at = now ? sql`${now.toISOString()}::timestamptz` : sql`now()`;
  try {
    return await withTenant(actor, async (tx) => {
      const { rows } = await tx.execute<Calculated>(sql`
        with ctx as (
          select t.id as table_id, t.restaurant_id, t.label, t.archived_at is not null as archived, r.timezone,
            ${at} as n,
            s.buffer_minutes * ${minute} as buffer,
            (case when ${party} >= s.large_party_size then s.large_party_sitting_minutes
                  else s.sitting_minutes end) * ${minute} as sitting
          from tables t
          join booking_settings s on s.restaurant_id = t.restaurant_id
          join restaurants r on r.id = t.restaurant_id
          where t.restaurant_id = ${actor.restaurantId} and t.id = ${tableId}
        ), plan as (
          select ctx.*, held.*, upcoming.*,
            held.busy_hold as busy,
            upcoming.next_starts as next,
            least(ctx.n + ctx.sitting, ${roomEnds}) as ends,
            (not ctx.archived and ${takesWalkIn}) as ok
          from ctx ${heldNow} ${upcoming}
        ), seated as (
          insert into bookings (restaurant_id, table_id, guest_name, guest_phone, whatsapp_opt_in,
            party_size, starts_at, ends_at, hold_ends_at, status, source, manage_token)
          select ${actor.restaurantId}, plan.table_id, 'Walk-in', null, false,
            ${party}, plan.n, plan.ends, plan.ends + plan.buffer, 'seated', 'staff', ${mintQrToken()}
          from plan where plan.ok
          returning id, ends_at, hold_ends_at
        )
        select plan.label, plan.archived, plan.timezone, plan.ok,
          extract(epoch from plan.busy) * 1000 as busy_ms,
          extract(epoch from plan.next) * 1000 as next_ms,
          plan.busy_id, plan.busy_resetting, plan.busy_name, plan.busy_party,
          extract(epoch from plan.busy_starts) * 1000 as busy_start_ms,
          plan.next_id, plan.next_name, plan.next_party,
          seated.id,
          extract(epoch from seated.ends_at) * 1000 as ends_ms,
          extract(epoch from seated.hold_ends_at) * 1000 as hold_ms
        from plan left join seated on true
      `);
      const row = rows[0];
      if (!row) return { outcome: "not_found" };
      const clock = (ms: number) => localTime(new Date(Number(ms)), row.timezone);
      if (row.archived) return { outcome: "table_archived", table: row.label };
      if (row.busy_ms !== null) {
        return {
          outcome: "table_occupied",
          table: row.label,
          freeAt: clock(row.busy_ms),
          resetting: row.busy_resetting === true,
          booking: bookingOf(row.busy_id, row.busy_name, row.busy_party, row.busy_start_ms, row.timezone),
        };
      }
      if (!row.ok || !row.id) {
        return {
          outcome: "booking_soon",
          table: row.label,
          at: clock(row.next_ms as number),
          booking: bookingOf(row.next_id, row.next_name, row.next_party, row.next_ms, row.timezone),
        };
      }
      await recordAdminAction(tx, actor, {
        action: "booking.walk_in",
        entityType: "booking",
        entityId: row.id,
      });
      return {
        outcome: "seated",
        bookingId: row.id,
        endsAt: new Date(Number(row.ends_ms)),
        holdEndsAt: new Date(Number(row.hold_ms)),
      };
    });
  } catch (error) {
    const cause = (error as { cause?: { code?: string; constraint?: string } } | null)?.cause;
    // The constraint (a booking landed first), the archive trigger or a deadlock between
    // two inserts: the table went to someone else. Drizzle's message quotes parameters.
    if (
      (cause?.code === "23P01" && cause.constraint === "bookings_no_overlap") ||
      (cause?.code === "23514" && cause.constraint === "bookings_table_live") ||
      cause?.code === "40P01"
    ) {
      return { outcome: "table_taken" };
    }
    throw new Error(`seating a walk-in failed: ${cause?.code ?? "unknown"}`);
  }
}

/** What the walk-in list says about one table: its availability right now. */
export type WalkInTable = {
  id: string;
  label: string;
  capacity: number;
  /**
   * free: seat now (`until` is when the next booking's reset buffer starts, which
   *   ends the sitting, and only when that can cut a sitting short);
   * in_use: a party is there or a booking runs late, `until` when it frees;
   * resetting: the party has gone and only the reset buffer holds it;
   * booking_soon: free now, but too little room before the next booking (refused),
   *   `until` its start.
   */
  state: "free" | "in_use" | "resetting" | "booking_soon";
  /** Restaurant-clock "HH:MM", or null for a free table with room for any sitting. */
  until: string | null;
};

type Listed = Pick<Calculated, "label" | "timezone" | "busy_ms" | "busy_resetting" | "next_ms" | "ok"> & {
  table_id: string;
  capacity: number;
  /** When the room ends, only when that is before the longest sitting from now would. */
  cut_ms: number | null;
};

/**
 * Which tables a walk-in can take, in one statement under the same rules as
 * seatWalkIn (it shares `heldNow`, `upcoming`, `roomEnds` and `takesWalkIn`). The
 * party isn't known yet, so the longer of the two sittings is the one a booking has
 * to come before to be worth saying. One row per live table of the session's
 * restaurant, in the restaurant's timezone; the lateral reads are bounded by table
 * and restaurant, so the cost is the number of tables, not the booking history.
 * `now` is the database's own now() unless a test passes one.
 */
export function walkInTables(tenant: Pick<TenantContext, "restaurantId">, now?: Date): Promise<WalkInTable[]> {
  const at = now ? sql`${now.toISOString()}::timestamptz` : sql`now()`;
  return withTenant(tenant, async (tx) => {
    const { rows } = await tx.execute<Listed>(sql`
      with ctx as (
        select t.id as table_id, t.restaurant_id, t.label, t.capacity, t.sort_order, r.timezone,
          ${at} as n, s.buffer_minutes * ${minute} as buffer,
          greatest(s.sitting_minutes, s.large_party_sitting_minutes) * ${minute} as longest
        from tables t
        join booking_settings s on s.restaurant_id = t.restaurant_id
        join restaurants r on r.id = t.restaurant_id
        where t.restaurant_id = ${tenant.restaurantId} and t.archived_at is null
      )
      select ctx.table_id, ctx.label, ctx.capacity, ctx.timezone, ${takesWalkIn} as ok,
        extract(epoch from held.busy_hold) * 1000 as busy_ms, held.busy_resetting,
        extract(epoch from upcoming.next_starts) * 1000 as next_ms,
        case when ${roomEnds} < ctx.n + ctx.longest then extract(epoch from ${roomEnds}) * 1000 end as cut_ms
      from ctx ${heldNow} ${upcoming}
      order by ctx.sort_order, ctx.label
    `);
    return rows.map((row): WalkInTable => {
      const clock = (ms: number | null) => (ms === null ? null : localTime(new Date(Number(ms)), row.timezone));
      const base = { id: row.table_id, label: row.label, capacity: row.capacity };
      if (row.busy_ms !== null) {
        return { ...base, state: row.busy_resetting ? "resetting" : "in_use", until: clock(row.busy_ms) };
      }
      return row.ok
        ? { ...base, state: "free", until: clock(row.cut_ms) }
        : { ...base, state: "booking_soon", until: clock(row.next_ms) };
    });
  });
}
