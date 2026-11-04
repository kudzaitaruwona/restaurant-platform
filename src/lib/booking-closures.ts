import "server-only";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { notFound } from "next/navigation";
import { z } from "zod";
import { bookings, closures, restaurants } from "@/db/schema";
import { addDays, dateLabel, isLocalDate, localTime, localToday } from "@/lib/booking-engine";
import { dbErrorOf, noNul } from "@/lib/bookings";
import { type TenantContext, type TenantTransaction, withTenant } from "@/lib/tenant";
import { recordAdminAction } from "@/lib/tenant/audit";

/**
 * Closures (spec 04 › Settings): owner only (S-26), callers check requireOwner(ctx).
 * The rule that matters is Postgres's: closures_cover_bookings refuses a closure
 * over a confirmed booking and bookings_within_closure refuses a booking inside
 * one, whichever commits first (migration 0026). The list read first here is for
 * the screen: it is what staff are shown, so they can cancel each booking.
 * Spec 01's audit list has no closures, so only a platform admin's are audited.
 *
 * Decided here *(proposed)*, where spec 04 is silent:
 *  - A closure is added and removed, never edited: to change one, remove it and add
 *    another. Removing frees times and can't hurt a seat, so it is allowed and
 *    needs no guard. It is a real delete: nothing refers to a closure.
 *  - It covers a booking when the booking's sitting runs into it, as the engine
 *    judges a time. The reset buffer doesn't count.
 *  - Only a confirmed booking is in the way. A seated party is at the table, and
 *    staff finish it; a walk-in is seated, so a closure doesn't stop staff seating
 *    who is at the door. Staff's Add booking keeps to closures, as there is no
 *    override for it in spec 04.
 *  - A closure starts no earlier than today, ends in the future, runs at most 366
 *    days (the start and end dates both counted) and ends within two years of today (so any date a form sends is either a
 *    refusal or a safe one), on the restaurant's calendar.
 */

type Tenant = Pick<TenantContext, "restaurantId">;
type Writer = Tenant & Pick<TenantContext, "platformAdminId">;

// --- the request ------------------------------------------------------------

const messages = {
  date: "Choose a date.",
  time: "Enter the times as hours and minutes, like 19:00.",
  bothTimes: "Give both a start and an end time, or neither for the whole day.",
  order: "The closure has to end after it starts.",
  past: "A closure can't start before today.",
  over: "That closure is already over.",
  far: "A closure can't end more than two years from today.",
  long: "A closure can run for 366 days at most.",
  reason: "Keep the reason to 200 characters.",
};

const timeOfDay = z
  .string(messages.time)
  .trim()
  .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, messages.time);

const dateField = z.string(messages.date).trim().refine(isLocalDate, messages.date);

/**
 * What a form sends: a start date, and an end date that defaults to it. With no
 * times it is the whole of those dates, from the first's local midnight to the
 * midnight after the last. With both times it is that range of the restaurant's
 * clock. A blank field is sent as an empty string.
 */
const closureForm = z
  .object({
    startDate: dateField,
    endDate: z.string().trim().default(""),
    startTime: z.string().trim().default(""),
    endTime: z.string().trim().default(""),
    reason: z
      .string(messages.reason)
      .trim()
      .max(200, messages.reason)
      .refine(noNul, messages.reason)
      .default(""),
  })
  .transform((form, context) => {
    const endDate = form.endDate === "" ? form.startDate : form.endDate;
    if (!isLocalDate(endDate)) {
      context.addIssue({ code: "custom", message: messages.date });
      return z.NEVER;
    }
    const timed = form.startTime !== "" || form.endTime !== "";
    if (timed) {
      for (const time of [form.startTime, form.endTime]) {
        if (time === "") {
          context.addIssue({ code: "custom", message: messages.bothTimes });
          return z.NEVER;
        }
        if (!timeOfDay.safeParse(time).success) {
          context.addIssue({ code: "custom", message: messages.time });
          return z.NEVER;
        }
      }
    }
    const startsAfterEnd =
      form.startDate > endDate ||
      (timed && form.startDate === endDate && form.startTime >= form.endTime);
    if (startsAfterEnd) {
      context.addIssue({ code: "custom", message: messages.order });
      return z.NEVER;
    }
    return {
      startDate: form.startDate,
      endDate,
      times: timed ? { start: form.startTime, end: form.endTime } : undefined,
      reason: form.reason === "" ? null : form.reason,
    };
  });

export type ClosureRequest = z.output<typeof closureForm>;

export function parseClosure(form: FormData) {
  const parsed = closureForm.safeParse(Object.fromEntries(form));
  return parsed.success
    ? ({ success: true, data: parsed.data } as const)
    : ({ success: false, message: parsed.error.issues[0].message } as const);
}

/** The id in a closure route. A malformed one is a 404, like an unknown one. */
export async function closureIdFrom(params: Promise<{ closureId: string }>) {
  const parsed = z.uuid().safeParse((await params).closureId);
  if (!parsed.success) notFound();
  return parsed.data;
}

// --- the bookings in the way ------------------------------------------------

/** The most bookings the refusal lists: a closure over more is a closure over a lot of days. */
const BLOCKING_LIST_LIMIT = 100;

/** The guard trigger's constraint name (migration 0026). */
const COVER_GUARD = "closures_cover_bookings";

export type BlockingBooking = {
  id: string;
  startsAt: string;
  guestName: string;
  partySize: number;
  /** "Fri 6 Nov, 19:00 · Tendai · 4 guests", on the restaurant's clock. Never a phone. */
  summary: string;
};

/**
 * The confirmed bookings a closure from `startsAt` to `endsAt` would cover, soonest
 * first: judged by booking_stops_closure and the same bounds as the trigger, so the
 * list and the refusal can't disagree. The read stops looking back 960 minutes
 * before the later of the closure's start and now (bookings_hold_capped, migration
 * 0022: no sitting outlasts its start by more) and uses the index on
 * (restaurant_id, starts_at), so it doesn't walk the restaurant's history. Guest
 * name and party only: no phone.
 */
async function blockingBookings(
  tx: TenantTransaction,
  restaurantId: string,
  timezone: string,
  window: { startsAt: Date; endsAt: Date },
): Promise<BlockingBooking[]> {
  const from = sql`greatest(${window.startsAt.toISOString()}::timestamptz, now())`;
  const rows = await tx
    .select({
      id: bookings.id,
      startsAt: bookings.startsAt,
      guestName: bookings.guestName,
      partySize: bookings.partySize,
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.restaurantId, restaurantId),
        sql`${bookings.startsAt} > ${from} - interval '960 minutes'`,
        sql`${bookings.startsAt} < ${window.endsAt.toISOString()}::timestamptz`,
        sql`${bookings.endsAt} > ${from}`,
        sql`public.booking_stops_closure(${bookings.status}, ${bookings.endsAt})`,
      ),
    )
    .orderBy(asc(bookings.startsAt), asc(bookings.id))
    .limit(BLOCKING_LIST_LIMIT);
  return rows.map((row) => ({
    id: row.id,
    startsAt: row.startsAt.toISOString(),
    guestName: row.guestName,
    partySize: row.partySize,
    summary:
      `${dateLabel(localToday(row.startsAt, timezone))}, ${localTime(row.startsAt, timezone)}` +
      ` · ${row.guestName} · ${row.partySize} ${row.partySize === 1 ? "guest" : "guests"}`,
  }));
}

const blockedBy = (list: BlockingBooking[]) => ({
  outcome: "blocked" as const,
  message: list.length
    ? "Those bookings are in the way. Cancel each one, then save the closure. To keep a guest, add them again at another time."
    : "A booking was just made in that time. Try again.",
  bookings: list,
});

// --- adding -----------------------------------------------------------------

export type AddClosureOutcome =
  | { outcome: "saved"; id: string }
  | { outcome: "invalid"; message: string }
  | ReturnType<typeof blockedBy>;

/**
 * The instants a request means, worked out by Postgres: `AT TIME ZONE` is the one
 * place a local midnight is turned into an instant, so a 23- or 25-hour day is
 * the length it is (the engine's `instantOf` must agree, and is tested to). A date
 * is a real date by now (isLocalDate) and within two years of today, so the
 * conversion can't fail. An hour that doesn't exist or happens twice on a clock
 * change is read as Postgres reads it.
 */
async function instantsOf(
  tx: TenantTransaction,
  timezone: string,
  request: ClosureRequest,
): Promise<{ startsAt: Date; endsAt: Date }> {
  const { startDate, endDate, times } = request;
  const {
    rows: [row],
  } = await tx.execute<{ starts_ms: string; ends_ms: string }>(
    times
      ? sql`select
          (extract(epoch from (${startDate}::date + ${times.start}::time) at time zone ${timezone}) * 1000)::bigint as starts_ms,
          (extract(epoch from (${endDate}::date + ${times.end}::time) at time zone ${timezone}) * 1000)::bigint as ends_ms`
      : sql`select
          (extract(epoch from ${startDate}::date::timestamp at time zone ${timezone}) * 1000)::bigint as starts_ms,
          (extract(epoch from (${endDate}::date + 1)::timestamp at time zone ${timezone}) * 1000)::bigint as ends_ms`,
  );
  return { startsAt: new Date(Number(row.starts_ms)), endsAt: new Date(Number(row.ends_ms)) };
}

const MAX_DAYS_AHEAD = 730;
const MAX_LENGTH_DAYS = 366;

/**
 * Saves a closure, or says why not. The dates are the restaurant's calendar. The
 * confirmed bookings it would cover are listed first, and nothing is saved while
 * there are any. What holds when a guest confirms at the moment of the save is
 * Postgres's: its refusal is answered with the list as it stands then.
 */
export async function addClosure(
  ctx: Writer,
  request: ClosureRequest,
  now = new Date(),
): Promise<AddClosureOutcome> {
  const { restaurantId } = ctx;
  let timezone = "";
  try {
    return await withTenant(ctx, async (tx): Promise<AddClosureOutcome> => {
      const [restaurant] = await tx
        .select({ timezone: restaurants.timezone })
        .from(restaurants)
        .where(eq(restaurants.id, restaurantId));
      timezone = restaurant.timezone;

      // Before any date arithmetic: 9999-12-31 is a real date, and the day after isn't.
      const today = localToday(now, timezone);
      if (request.startDate < today) return { outcome: "invalid", message: messages.past };
      if (request.endDate > addDays(today, MAX_DAYS_AHEAD)) {
        return { outcome: "invalid", message: messages.far };
      }
      // The start and end dates are both days of the closure, so 366 days ends 365 days on.
      if (request.endDate > addDays(request.startDate, MAX_LENGTH_DAYS - 1)) {
        return { outcome: "invalid", message: messages.long };
      }

      const { startsAt, endsAt } = await instantsOf(tx, timezone, request);
      if (endsAt.getTime() <= startsAt.getTime()) return { outcome: "invalid", message: messages.order };
      if (endsAt.getTime() <= now.getTime()) return { outcome: "invalid", message: messages.over };

      const blocking = await blockingBookings(tx, restaurantId, timezone, { startsAt, endsAt });
      if (blocking.length > 0) return blockedBy(blocking);

      const [added] = await tx
        .insert(closures)
        .values({ restaurantId, startsAt, endsAt, reason: request.reason })
        .returning({ id: closures.id });
      await recordAdminAction(tx, ctx, {
        action: "closure.create",
        entityType: "closure",
        entityId: added.id,
      });
      return { outcome: "saved", id: added.id };
    });
  } catch (error) {
    const constraint = dbErrorOf(error)?.constraint;
    if (constraint === "closures_times_ordered") return { outcome: "invalid", message: messages.order };
    if (constraint !== COVER_GUARD) throw error;
    // Lost a race with a confirm: the guard refused, so nothing was saved.
    return withTenant(ctx, async (tx) => {
      const { startsAt, endsAt } = await instantsOf(tx, timezone, request);
      return blockedBy(await blockingBookings(tx, restaurantId, timezone, { startsAt, endsAt }));
    });
  }
}

// --- listing and removing ---------------------------------------------------

export type ClosureRow = {
  id: string;
  /** "Fri 6 Nov", "Fri 6 Nov to Sun 8 Nov" or "Fri 6 Nov, 19:00 to 22:00", on the restaurant's clock. */
  label: string;
  reason: string | null;
};

/** How a closure reads: whole dates when it runs midnight to midnight, otherwise with times. */
export function closureLabel(startsAt: Date, endsAt: Date, timezone: string) {
  const startDay = localToday(startsAt, timezone);
  const endDay = localToday(endsAt, timezone);
  const startTime = localTime(startsAt, timezone);
  const endTime = localTime(endsAt, timezone);
  if (startTime === "00:00" && endTime === "00:00") {
    const lastDay = addDays(endDay, -1);
    return startDay === lastDay
      ? dateLabel(startDay)
      : `${dateLabel(startDay)} to ${dateLabel(lastDay)}`;
  }
  return startDay === endDay
    ? `${dateLabel(startDay)}, ${startTime} to ${endTime}`
    : `${dateLabel(startDay)}, ${startTime} to ${dateLabel(endDay)}, ${endTime}`;
}

/** Closures that haven't ended yet, soonest first. Past ones are never read. */
export function listClosures(ctx: Tenant, now = new Date()) {
  return withTenant(ctx, async (tx): Promise<ClosureRow[]> => {
    const [{ timezone }] = await tx
      .select({ timezone: restaurants.timezone })
      .from(restaurants)
      .where(eq(restaurants.id, ctx.restaurantId));
    const rows = await tx
      .select({
        id: closures.id,
        startsAt: closures.startsAt,
        endsAt: closures.endsAt,
        reason: closures.reason,
      })
      .from(closures)
      .where(and(eq(closures.restaurantId, ctx.restaurantId), gt(closures.endsAt, now)))
      .orderBy(asc(closures.startsAt), asc(closures.id))
      .limit(200);
    return rows.map(({ id, startsAt, endsAt, reason }) => ({
      id,
      label: closureLabel(startsAt, endsAt, timezone),
      reason,
    }));
  });
}

/** Removes a closure: its times can be booked again at once. Nothing refers to one. */
export function deleteClosure(ctx: Writer, closureId: string): Promise<"saved" | "not_found"> {
  return withTenant(ctx, async (tx) => {
    const deleted = await tx
      .delete(closures)
      .where(and(eq(closures.restaurantId, ctx.restaurantId), eq(closures.id, closureId)))
      .returning({ id: closures.id });
    if (deleted.length === 0) return "not_found" as const;
    await recordAdminAction(tx, ctx, {
      action: "closure.delete",
      entityType: "closure",
      entityId: closureId,
    });
    return "saved" as const;
  });
}
