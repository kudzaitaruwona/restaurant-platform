import "server-only";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { diningTables } from "@/db/schema";
import { blockingStatuses, localTime } from "@/lib/booking-engine";
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
  /** Someone is at the table now, or its reset buffer runs on: `freeAt` is when it frees. */
  | { outcome: "table_occupied"; table: string; freeAt: string }
  /** Under 30 minutes before the next booking: `at` is that booking's start. */
  | { outcome: "booking_soon"; table: string; at: string }
  /** A guest's confirm or an owner's edit won the table between the read and the insert. */
  | { outcome: "table_taken" };

type Calculated = {
  table_id: string;
  label: string;
  archived: boolean;
  timezone: string;
  busy_ms: number | null;
  next_ms: number | null;
  ok: boolean;
  id: string | null;
  ends_ms: number | null;
  hold_ms: number | null;
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
  const blocking = sql.join(
    blockingStatuses.map((status) => sql`${status}`),
    sql`, `,
  );
  const minute = sql`interval '1 minute'`;
  try {
    return await withTenant(actor, async (tx) => {
      const { rows } = await tx.execute<Calculated>(sql`
        with ctx as (
          select t.id as table_id, t.label, t.archived_at is not null as archived, r.timezone,
            ${at} as n,
            s.buffer_minutes * ${minute} as buffer,
            (case when ${party} >= s.large_party_size then s.large_party_sitting_minutes
                  else s.sitting_minutes end) * ${minute} as sitting
          from tables t
          join booking_settings s on s.restaurant_id = t.restaurant_id
          join restaurants r on r.id = t.restaurant_id
          where t.restaurant_id = ${actor.restaurantId} and t.id = ${tableId}
        ), calc as (
          select ctx.*,
            (select max(b.hold_ends_at) from bookings b
              where b.restaurant_id = ${actor.restaurantId} and b.table_id = ctx.table_id
                and b.status in (${blocking}) and b.starts_at <= ctx.n and b.hold_ends_at > ctx.n
                -- bookings_hold_capped keeps a hold within 960 minutes of its start, so
                -- nothing that started earlier can still hold the table. Raising that
                -- cap means raising this bound too.
                and b.starts_at > ctx.n - 960 * ${minute}) as busy,
            (select min(b.starts_at) from bookings b
              where b.restaurant_id = ${actor.restaurantId} and b.table_id = ctx.table_id
                and b.status in (${blocking}) and b.starts_at > ctx.n) as next
          from ctx
        ), plan as (
          select calc.*,
            least(calc.n + calc.sitting, calc.next - calc.buffer) as ends,
            (not calc.archived and calc.busy is null
              and (calc.next is null
                or calc.next - calc.buffer - calc.n >= ${WALK_IN_MIN_MINUTES} * ${minute})) as ok
          from calc
        ), seated as (
          insert into bookings (restaurant_id, table_id, guest_name, guest_phone, whatsapp_opt_in,
            party_size, starts_at, ends_at, hold_ends_at, status, source, manage_token)
          select ${actor.restaurantId}, plan.table_id, 'Walk-in', null, false,
            ${party}, plan.n, plan.ends, plan.ends + plan.buffer, 'seated', 'staff', ${mintQrToken()}
          from plan where plan.ok
          returning id, ends_at, hold_ends_at
        )
        select plan.table_id, plan.label, plan.archived, plan.timezone, plan.ok,
          extract(epoch from plan.busy) * 1000 as busy_ms,
          extract(epoch from plan.next) * 1000 as next_ms,
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
        return { outcome: "table_occupied", table: row.label, freeAt: clock(row.busy_ms) };
      }
      if (!row.ok || !row.id) {
        return { outcome: "booking_soon", table: row.label, at: clock(row.next_ms as number) };
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

/** The tables a walk-in can be seated at: live ones, bookable or not (walk-in only means exactly this). */
export function walkInTables(tenant: Pick<TenantContext, "restaurantId">) {
  return withTenant(tenant, (tx) =>
    tx
      .select({ id: diningTables.id, label: diningTables.label, capacity: diningTables.capacity })
      .from(diningTables)
      .where(and(eq(diningTables.restaurantId, tenant.restaurantId), isNull(diningTables.archivedAt)))
      .orderBy(asc(diningTables.sortOrder), asc(diningTables.label)),
  );
}
