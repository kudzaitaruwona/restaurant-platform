import "server-only";
import { and, asc, eq, gt, isNull, lt } from "drizzle-orm";
import { z } from "zod";
import { bookings, diningTables, restaurants } from "@/db/schema";
import {
  addDays,
  availableTimes,
  candidateTimes,
  freeTables,
  holdFor,
  instantOf,
  isLocalDate,
  type LocalDate,
  localToday,
  staffRules,
  tablesFor,
  type EngineTable,
} from "@/lib/booking-engine";
import {
  dbErrorOf,
  E164,
  firstTableToTake,
  MAX_HOLD_MS,
  noNul,
  readDayInputs,
  readRules,
  toE164,
} from "@/lib/bookings";
import { mintQrToken } from "@/lib/qr-token";
import { recordAdminAction, recordAudit } from "@/lib/tenant/audit";
import { type TenantContext, type TenantTransaction, withTenant } from "@/lib/tenant/scope";

/**
 * Staff add a booking and move one (spec 04, Staff actions). Owners and staff both
 * (S-26), so nothing here checks the role; the restaurant is always the context's,
 * never a field of the request. Adding goes through the same engine as the guest's
 * confirm, under `staffRules`, and Postgres has the last word, as there.
 */

type Actor = Pick<TenantContext, "restaurantId" | "staffId" | "platformAdminId">;

// --- the request ------------------------------------------------------------

const messages = {
  choice: "That booking wasn't complete. Check the party, date and time.",
  name: "Enter the guest's name, up to 100 characters.",
  phone: "That phone number doesn't look right. Leave it blank if there isn't one.",
  note: "Keep the note to 200 characters.",
};

const staffRequest = z
  .object({
    party: z
      .string(messages.choice)
      .regex(/^[0-9]{1,3}$/, messages.choice)
      .transform(Number)
      .refine((party) => party >= 1, messages.choice),
    date: z.string(messages.choice).refine(isLocalDate, messages.choice),
    time: z.string(messages.choice).regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, messages.choice),
    // Blank means the engine picks, as for a guest. Anything else is looked up among
    // this restaurant's tables, so an unknown or malformed one is just "not found".
    tableId: z.string().max(100).default(""),
    name: z
      .string(messages.name)
      .trim()
      .min(1, messages.name)
      .max(100, messages.name)
      .refine(noNul, messages.name),
    countryCode: z.string(messages.phone).max(8, messages.phone).default("+263"),
    // Optional: a booking taken in person or for a walk-up has none.
    phone: z.string(messages.phone).max(40, messages.phone).default(""),
    note: z.string(messages.note).trim().max(200, messages.note).refine(noNul, messages.note).optional(),
    whatsapp: z.string().optional(),
  })
  .transform(({ countryCode, phone, note, whatsapp, tableId, ...rest }) => {
    const number = phone.replace(/[\s().-]/g, "");
    const e164 = number === "" ? null : toE164(countryCode, phone);
    return {
      ...rest,
      tableId: tableId || undefined,
      phone: e164,
      note: note || null,
      // Consent is the guest's to give: a number alone doesn't carry it *(proposed)*.
      whatsappOptIn: e164 !== null && whatsapp === "on",
    };
  })
  .refine(({ phone }) => phone === null || E164.test(phone), messages.phone);

export type StaffRequest = z.output<typeof staffRequest>;

export function parseStaffRequest(form: FormData) {
  const parsed = staffRequest.safeParse(Object.fromEntries(form));
  return parsed.success
    ? ({ success: true, data: parsed.data } as const)
    : ({ success: false, message: parsed.error.issues[0].message } as const);
}

// --- adding -----------------------------------------------------------------

export type AddOutcome =
  | { outcome: "added"; id: string; date: LocalDate; time: string; table: string }
  /** Before today or past max_days_ahead on the restaurant's calendar. */
  | { outcome: "date_unavailable" }
  /** Not a time the restaurant's service periods give on that day, or already past. */
  | { outcome: "time_unavailable" }
  /** Not a table of this restaurant (so also another restaurant's): a 404. */
  | { outcome: "table_not_found" }
  | { outcome: "table_archived" }
  | { outcome: "too_small"; capacity: number }
  /** Automatic, and no live table seats the party. */
  | { outcome: "no_fit" }
  /** Free at the time of looking, gone by the insert, or never free. */
  | { outcome: "taken" }
  | { outcome: "hold_too_long" };

/**
 * Adds a staff booking, or says why not. The engine decides what is free, at the
 * same instant and under the same rules as a guest's confirm bar the overrides in
 * `staffRules`, plus two that are staff's by nature *(proposed)*: a hand-picked
 * table may be walk-ins only (bookable = false), and the guest's phone may be blank.
 * A hand-picked table is held to the same engine, offered alone: archived and too
 * small are refused, and a taken one is "taken", never an error.
 *
 * The insert runs in a SAVEPOINT per table, like the guest's, so the exclusion
 * constraint losing a race is an answer. bookings_max_active_per_phone is for
 * online bookings only, so staff may add past a phone's limit.
 */
export async function addStaffBooking(
  actor: Actor,
  request: StaffRequest,
  now = new Date(),
): Promise<AddOutcome> {
  const { party, date, time } = request;
  try {
    return await withTenant(actor, async (tx): Promise<AddOutcome> => {
      const read = await readRules(tx, actor);
      const { restaurant, rules, periods } = read;
      const { timezone } = restaurant;

      // Before any date arithmetic, as the guest's confirm: 9999-12-31 is a real date.
      const today = localToday(now, timezone);
      if (date < today || date > addDays(today, rules.maxDaysAhead)) {
        return { outcome: "date_unavailable" };
      }
      const staffView = staffRules(rules);
      const slot = candidateTimes({ date, rules: staffView, periods, timezone, now }).find(
        (candidate) => candidate.time === time,
      );
      if (!slot) return { outcome: "time_unavailable" };

      const { tables, holds } = await readDayInputs(tx, actor, date, timezone);
      let offered: readonly EngineTable[] = tables;
      let handPicked: EngineTable | undefined;
      if (request.tableId) {
        handPicked = tables.find((table) => table.id === request.tableId);
        if (!handPicked) return { outcome: "table_not_found" };
        if (handPicked.archivedAt !== null) return { outcome: "table_archived" };
        if (handPicked.capacity < party) return { outcome: "too_small", capacity: handPicked.capacity };
        // The engine takes bookable tables only; staff may use a walk-in one.
        offered = [{ ...handPicked, bookable: true }];
      } else if (tablesFor(tables, party).length === 0) {
        return { outcome: "no_fit" };
      }

      const free = availableTimes({ party, date, rules: staffView, periods, tables: offered, holds, timezone, now })
        .find((candidate) => candidate.time === time);
      const booked = free
        ? await firstTableToTake(tx, free.tableIds, async (attempt, tableId) => {
            const [row] = await attempt
              .insert(bookings)
              .values({
                restaurantId: actor.restaurantId,
                tableId,
                guestName: request.name,
                guestPhone: request.phone,
                whatsappOptIn: request.whatsappOptIn,
                partySize: party,
                ...holdFor(rules, party, slot.startsAt),
                status: "confirmed",
                source: "staff",
                guestNote: request.note,
                manageToken: mintQrToken(),
              })
              .returning({ id: bookings.id });
            return { id: row.id, tableId };
          })
        : undefined;
      if (!booked) return { outcome: "taken" };

      await recordAdminAction(tx, actor, {
        action: "booking.create",
        entityType: "booking",
        entityId: booked.id,
      });
      const label = await labelOf(tx, actor.restaurantId, booked.tableId);
      return { outcome: "added", id: booked.id, date, time, table: label };
    });
  } catch (error) {
    const cause = dbErrorOf(error);
    if (cause?.code === "23514" && cause.constraint === "bookings_hold_capped") {
      return { outcome: "hold_too_long" };
    }
    // A Drizzle error's message quotes the statement's parameters: the guest's name and phone.
    throw new Error(`adding a booking failed: ${cause?.code ?? "unknown"}`);
  }
}

async function labelOf(tx: TenantTransaction, restaurantId: string, tableId: string) {
  const [row] = await tx
    .select({ label: diningTables.label })
    .from(diningTables)
    .where(and(eq(diningTables.restaurantId, restaurantId), eq(diningTables.id, tableId)));
  return row?.label ?? "";
}

/** What the add-booking page needs for the party and date chosen so far. */
export function getStaffBookingForm(
  tenant: Pick<TenantContext, "restaurantId">,
  choice: { party?: string; date?: string },
  now = new Date(),
) {
  return withTenant(tenant, async (tx) => {
    const read = await readRules(tx, tenant);
    const { rules, periods, restaurant: { timezone } } = read;
    const today = localToday(now, timezone);
    const last = addDays(today, rules.maxDaysAhead);

    const party = /^[0-9]{1,3}$/.test(choice.party ?? "") && Number(choice.party) >= 1 ? Number(choice.party) : undefined;
    const date = choice.date && isLocalDate(choice.date) && choice.date >= today && choice.date <= last ? choice.date : undefined;

    const tables = await tx
      .select({
        id: diningTables.id,
        label: diningTables.label,
        capacity: diningTables.capacity,
        bookable: diningTables.bookable,
      })
      .from(diningTables)
      .where(and(eq(diningTables.restaurantId, tenant.restaurantId), isNull(diningTables.archivedAt)))
      .orderBy(asc(diningTables.sortOrder), asc(diningTables.label));

    let times: { time: string; period: string; open: boolean }[] | undefined;
    if (party && date) {
      const staffView = staffRules(rules);
      const day = await readDayInputs(tx, tenant, date, timezone);
      const free = new Set(
        availableTimes({ party, date, rules: staffView, periods, ...day, timezone, now }).map(({ time }) => time),
      );
      times = candidateTimes({ date, rules: staffView, periods, timezone, now }).map(({ time, period }) => ({
        time,
        period,
        open: free.has(time),
      }));
    }
    return { today, last, party, date, tables, times };
  });
}

// --- moving -----------------------------------------------------------------

export type MoveOutcome =
  | { outcome: "moved"; from: string; to: string }
  | { outcome: "not_found" }
  | { outcome: "table_not_found" }
  /** Only a confirmed booking moves *(proposed)*: the status it is now. */
  | { outcome: "wrong_status"; status: (typeof bookings.$inferSelect)["status"] }
  | { outcome: "same_table" }
  | { outcome: "table_archived" }
  /** An online booking can't hold a walk-ins-only table (bookings_table_bookable, #40). */
  | { outcome: "walk_in_only" }
  | { outcome: "taken" };

/**
 * Moves a confirmed booking to another table, if that table is free for its whole
 * hold. The booking's row is locked first, so a move racing a Seat or a Cancel
 * waits for it and then re-reads the status: whoever came second is told what the
 * booking now is (409), never overwritten. Postgres judges the table: the
 * exclusion constraint refuses an overlapping hold, and #40's
 * bookings_table_live_update refuses an archived table or, for an online booking,
 * a walk-ins-only one.
 *
 * Decided here *(proposed)*:
 *  - Only `confirmed` bookings move. A seated party is at a table already, and a
 *    stale tap must not move the record away from where they sit; completed,
 *    cancelled and no-show are over.
 *  - Any live table free for the hold will do, however many it seats: spec 04
 *    says "any table that's free for the hold window", and staff can see the
 *    room. (Add booking keeps its capacity rule.)
 *  - Staff may move a booking to a walk-ins-only table, bar an online booking
 *    (the database says no, and the list leaves those out).
 *  - The guest isn't messaged, and the move is audited (spec 01) for everyone.
 */
export async function moveBooking(actor: Actor, bookingId: string, tableId: string): Promise<MoveOutcome> {
  try {
    return await withTenant(actor, async (tx): Promise<MoveOutcome> => {
      const [booking] = await tx
        .select({
          status: bookings.status,
          source: bookings.source,
          partySize: bookings.partySize,
          tableId: bookings.tableId,
        })
        .from(bookings)
        .where(and(eq(bookings.restaurantId, actor.restaurantId), eq(bookings.id, bookingId)))
        .for("update");
      if (!booking) return { outcome: "not_found" };
      const [target] = await tx
        .select({
          capacity: diningTables.capacity,
          bookable: diningTables.bookable,
          archivedAt: diningTables.archivedAt,
          label: diningTables.label,
        })
        .from(diningTables)
        .where(and(eq(diningTables.restaurantId, actor.restaurantId), eq(diningTables.id, tableId)));
      if (!target) return { outcome: "table_not_found" };

      if (booking.status !== "confirmed") return { outcome: "wrong_status", status: booking.status };
      if (booking.tableId === tableId) return { outcome: "same_table" };
      if (target.archivedAt !== null) return { outcome: "table_archived" };
      if (booking.source === "online" && !target.bookable) return { outcome: "walk_in_only" };

      const moved = await tx
        .update(bookings)
        .set({ tableId })
        .where(
          and(
            eq(bookings.restaurantId, actor.restaurantId),
            eq(bookings.id, bookingId),
            eq(bookings.status, "confirmed"),
          ),
        )
        .returning({ id: bookings.id });
      if (moved.length === 0) return { outcome: "not_found" };

      await recordAudit(tx, actor, {
        action: "booking.move",
        entityType: "booking",
        entityId: bookingId,
        details: { fromTableId: booking.tableId, toTableId: tableId },
      });
      return { outcome: "moved", from: booking.tableId, to: tableId };
    });
  } catch (error) {
    const cause = dbErrorOf(error);
    if (cause?.code === "23P01" && cause.constraint === "bookings_no_overlap") return { outcome: "taken" };
    if (cause?.code === "23514" && cause.constraint === "bookings_table_live") return { outcome: "table_archived" };
    if (cause?.code === "23514" && cause.constraint === "bookings_table_bookable") return { outcome: "walk_in_only" };
    // Two writers waiting on each other's rows: Postgres failed this one, so it lost the table.
    if (cause?.code === "40P01") return { outcome: "taken" };
    throw new Error(`moving a booking failed: ${cause?.code ?? "unknown"}`);
  }
}

/**
 * For each confirmed booking on a day, the tables it could move to now: free for
 * its hold, live (any size), and bookable if the booking is online. Three reads
 * however many bookings: advice for the screen, the constraint is what decides.
 */
export function getMoveTargets(
  tenant: Pick<TenantContext, "restaurantId">,
  date: LocalDate,
): Promise<Record<string, { id: string; label: string; capacity: number; walkInOnly: boolean }[]>> {
  return withTenant(tenant, async (tx) => {
    const [{ timezone }] = await tx
      .select({ timezone: restaurants.timezone })
      .from(restaurants)
      .where(eq(restaurants.id, tenant.restaurantId));
    const dayStarts = instantOf(date, "00:00", timezone);
    const dayEnds = instantOf(addDays(date, 1), "00:00", timezone);
    const rows = await tx
      .select({
        id: bookings.id,
        tableId: bookings.tableId,
        startsAt: bookings.startsAt,
        holdEndsAt: bookings.holdEndsAt,
        status: bookings.status,
        source: bookings.source,
        party: bookings.partySize,
      })
      .from(bookings)
      .where(
        and(
          eq(bookings.restaurantId, tenant.restaurantId),
          gt(bookings.startsAt, new Date(dayStarts.getTime() - MAX_HOLD_MS)),
          lt(bookings.startsAt, new Date(dayEnds.getTime() + MAX_HOLD_MS)),
          gt(bookings.holdEndsAt, dayStarts),
        ),
      );
    const mine = rows.filter(
      (row) => row.status === "confirmed" && row.startsAt >= dayStarts && row.startsAt < dayEnds,
    );
    if (mine.length === 0) return {};
    const tables = await tx
      .select({
        id: diningTables.id,
        label: diningTables.label,
        capacity: diningTables.capacity,
        bookable: diningTables.bookable,
        sortOrder: diningTables.sortOrder,
        archivedAt: diningTables.archivedAt,
      })
      .from(diningTables)
      .where(eq(diningTables.restaurantId, tenant.restaurantId));
    return Object.fromEntries(
      mine.map((row) => [
        row.id,
        freeTables(tables, rows, {
          startsAt: row.startsAt,
          holdEndsAt: row.holdEndsAt,
          ignore: row.id,
        })
          .filter((table) => table.id !== row.tableId && (table.bookable || row.source === "staff"))
          .map((table) => ({
            id: table.id,
            label: tables.find(({ id }) => id === table.id)!.label,
            capacity: table.capacity,
            walkInOnly: !table.bookable,
          })),
      ]),
    );
  });
}
