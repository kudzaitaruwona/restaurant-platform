import "server-only";
import { and, asc, count, eq, gt, isNull, lt, max, sql } from "drizzle-orm";
import { z } from "zod";
import {
  bookings,
  bookingSettings,
  closures,
  diningTables,
  restaurants,
  servicePeriods,
} from "@/db/schema";
import {
  addDays,
  availableTimes,
  bookableDates,
  type AvailableTime,
  type Closure,
  dateLabel,
  holdFor,
  instantOf,
  isLocalDate,
  type LocalDate,
  localToday,
  localTime,
  nearestTimes,
} from "@/lib/booking-engine";
import { queueBookingCancelled, queueBookingConfirmed } from "@/lib/notifications";
import { mintQrToken } from "@/lib/qr-token";
import { whatsappLink } from "@/lib/whatsapp-link";
import { type TenantContext, type TenantTransaction, withTenant } from "@/lib/tenant/scope";

/**
 * Bookings against the database: what /r/{slug}/book reads, and the confirm. The
 * rules are the engine's and Postgres's; this feeds one and catches the other. On the public path, so it imports the tenant scope, not
 * "@/lib/tenant", which would load sign-in (S-32).
 */

type Tenant = Pick<TenantContext, "restaurantId">;

/** A time a guest can pick. No table: a guest never sees one (spec 04). */
export type TimeChoice = Pick<AvailableTime, "period" | "time">;

const choices = (times: readonly AvailableTime[]): TimeChoice[] =>
  times.map(({ period, time }) => ({ period, time }));

/**
 * Longest possible hold: bounded by booking_settings' CHECKs (sitting 720, buffer
 * 240). A booking from the night before can still reach into a date's first slot,
 * and a slot's hold into the next date's bookings, so a date's holds are read by
 * overlap with this wider window, never by the date they start on. The read also
 * stops looking back at MAX_HOLD_MS before the date, so it doesn't scan a
 * restaurant's whole history; bookings_hold_capped (migration 0022) is what makes
 * that safe: no hold can be longer, however a booking is made.
 */
export const MAX_HOLD_MS = (720 + 240) * 60_000;

/** Everything about the restaurant the engine needs, bar the bookings. */
export async function readRules(tx: TenantTransaction, { restaurantId }: Tenant) {
  const [restaurant] = await tx
    .select({
      name: restaurants.name,
      timezone: restaurants.timezone,
      contactPhone: restaurants.contactPhone,
    })
    .from(restaurants)
    .where(eq(restaurants.id, restaurantId));
  const [rules] = await tx
    .select({
      enabled: bookingSettings.enabled,
      slotIntervalMinutes: bookingSettings.slotIntervalMinutes,
      sittingMinutes: bookingSettings.sittingMinutes,
      largePartySize: bookingSettings.largePartySize,
      largePartySittingMinutes: bookingSettings.largePartySittingMinutes,
      bufferMinutes: bookingSettings.bufferMinutes,
      minLeadMinutes: bookingSettings.minLeadMinutes,
      maxDaysAhead: bookingSettings.maxDaysAhead,
      maxOnlinePartySize: bookingSettings.maxOnlinePartySize,
      maxActiveBookingsPerPhone: bookingSettings.maxActiveBookingsPerPhone,
    })
    .from(bookingSettings)
    .where(eq(bookingSettings.restaurantId, restaurantId));
  const periods = await tx
    .select({
      name: servicePeriods.name,
      weekday: servicePeriods.weekday,
      opensAt: servicePeriods.opensAt,
      lastBookingAt: servicePeriods.lastBookingAt,
    })
    .from(servicePeriods)
    .where(eq(servicePeriods.restaurantId, restaurantId));
  return { restaurant, rules, periods };
}

export type ReadRules = Awaited<ReturnType<typeof readRules>>;

/**
 * The smallest party that can't book online: one more than the most the rules
 * allow and than the biggest table a guest could be given. D-02: a table is one
 * booking, so a bigger party gets the contact message, not an empty list.
 */
async function contactThreshold(
  tx: TenantTransaction,
  { restaurantId }: Tenant,
  { maxOnlinePartySize }: ReadRules["rules"],
) {
  const [{ capacity }] = await tx
    .select({ capacity: max(diningTables.capacity) })
    .from(diningTables)
    .where(
      and(
        eq(diningTables.restaurantId, restaurantId),
        eq(diningTables.bookable, true),
        isNull(diningTables.archivedAt),
      ),
    );
  return Math.min(maxOnlinePartySize, capacity ?? 0) + 1;
}

/** Where a guest can reach the restaurant instead: its number, and WhatsApp if it can take it. */
const contactOf = (phone: string | null) => ({
  contactPhone: phone,
  whatsappLink: whatsappLink(phone) ?? null,
});

/**
 * The closures that touch [from, to), soonest end first. The lower bound is the
 * read's own: a closure that ended before `from` is never read, so past years'
 * closures cost nothing (the index is on restaurant_id and ends_at, migration
 * 0026). Closures are never changed behind a read, and what Postgres refuses at
 * the insert is bookings_within_closure, whatever this saw.
 */
export async function readClosures(
  tx: TenantTransaction,
  { restaurantId }: Tenant,
  window: { from: Date; to: Date },
): Promise<Closure[]> {
  return tx
    .select({ startsAt: closures.startsAt, endsAt: closures.endsAt })
    .from(closures)
    .where(
      and(
        eq(closures.restaurantId, restaurantId),
        gt(closures.endsAt, window.from),
        lt(closures.startsAt, window.to),
      ),
    )
    .orderBy(asc(closures.endsAt));
}

/**
 * The tables, the holds and the closures that can reach into `date`: what the
 * engine needs besides the rules. Staff booking reads them through here too.
 */
export async function readDayInputs(
  tx: TenantTransaction,
  { restaurantId }: Tenant,
  date: LocalDate,
  timezone: string,
) {
  const tables = await tx
    .select({
      id: diningTables.id,
      capacity: diningTables.capacity,
      bookable: diningTables.bookable,
      sortOrder: diningTables.sortOrder,
      archivedAt: diningTables.archivedAt,
    })
    .from(diningTables)
    .where(eq(diningTables.restaurantId, restaurantId));
  const dayStarts = instantOf(date, "00:00", timezone);
  const dayEnds = instantOf(addDays(date, 1), "00:00", timezone);
  const holds = await tx
    .select({
      tableId: bookings.tableId,
      startsAt: bookings.startsAt,
      holdEndsAt: bookings.holdEndsAt,
      status: bookings.status,
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.restaurantId, restaurantId),
        gt(bookings.startsAt, new Date(dayStarts.getTime() - MAX_HOLD_MS)),
        lt(bookings.startsAt, new Date(dayEnds.getTime() + MAX_HOLD_MS)),
        gt(bookings.holdEndsAt, dayStarts),
      ),
    );
  // A sitting that starts on the date can run past midnight, into a closure that
  // starts the next day: a sitting is at most 720 minutes, so MAX_HOLD_MS is plenty.
  const dayClosures = await readClosures(tx, { restaurantId }, {
    from: dayStarts,
    to: new Date(dayEnds.getTime() + MAX_HOLD_MS),
  });
  return { tables, holds, closures: dayClosures };
}

/** The one path to what can be seated: the guest's list and confirm both come here. */
async function timesOn(
  tx: TenantTransaction,
  tenant: Tenant,
  { rules, periods, restaurant: { timezone } }: ReadRules,
  { party, date, now }: { party: number; date: LocalDate; now: Date },
) {
  const { tables, holds, closures: dayClosures } = await readDayInputs(tx, tenant, date, timezone);
  return availableTimes({
    party,
    date,
    rules,
    periods,
    closures: dayClosures,
    tables,
    holds,
    timezone,
    now,
  });
}

// --- the guest's page -------------------------------------------------------

/**
 * What the booking page shows for what's been chosen so far. The choices come
 * from the URL, so anything that isn't a real choice counts as not chosen.
 */
export function getBookingPage(
  tenant: Tenant,
  choice: { party?: string; date?: string },
  now = new Date(),
) {
  return withTenant(tenant, async (tx) => {
    const read = await readRules(tx, tenant);
    const { restaurant, rules, periods } = read;
    const { timezone } = restaurant;

    const party = /^[0-9]{1,3}$/.test(choice.party ?? "") ? Number(choice.party) : undefined;
    const threshold = await contactThreshold(tx, tenant, rules);
    const requestedParty = party && party >= 1 ? party : undefined;
    const tooLarge = requestedParty !== undefined && requestedParty >= threshold;
    const chosenParty = requestedParty && !tooLarge ? requestedParty : undefined;

    // From now, not from the start of time: a closure already over can't take a
    // date away. A sitting on the last date can run on into a closure after it.
    const lastDate = addDays(localToday(now, timezone), rules.maxDaysAhead);
    const windowClosures = await readClosures(tx, tenant, {
      from: now,
      to: new Date(instantOf(addDays(lastDate, 1), "00:00", timezone).getTime() + MAX_HOLD_MS),
    });
    const dates = bookableDates({
      rules,
      periods,
      closures: windowClosures,
      party: chosenParty,
      timezone,
      now,
    }).map((day) => ({
      ...day,
      label: dateLabel(day.date),
    }));

    const chosenDate = dates.find((day) => day.open && day.date === choice.date);
    const times =
      rules.enabled && chosenParty && chosenDate
        ? await timesOn(tx, tenant, read, { party: chosenParty, date: chosenDate.date, now })
        : undefined;

    return {
      restaurantName: restaurant.name,
      contactPhone: restaurant.contactPhone,
      enabled: rules.enabled,
      maxParty: rules.maxOnlinePartySize,
      requestedParty,
      // Shown in place of the times: for groups of this many, or more, contact the
      // restaurant. Only while booking is on, as everything else on the page is.
      largeParty: rules.enabled && tooLarge ? { threshold, ...contactOf(restaurant.contactPhone) } : undefined,
      dates,
      party: chosenParty,
      date: chosenDate,
      times: times && choices(times),
    };
  });
}

// --- the guest's request ----------------------------------------------------

const DEFAULT_COUNTRY_CODE = "+263";

const messages = {
  choice: "That booking request wasn't complete. Choose a time again.",
  name: "Enter your name, up to 100 characters.",
  phone: "Enter a WhatsApp number we can reach you on.",
  note: "Keep the note to 200 characters.",
  consent: "Tick the box so we can send your confirmation and reminder on WhatsApp.",
};

// Postgres can't store a NUL byte in text, so one is a refusal here, not a 500.
export const noNul = (value: string) => !value.includes("\0");

/**
 * The number as E.164. A local number's leading 0 is the trunk prefix, not part
 * of it, and a number typed with its own + already has its country code *(proposed)*.
 */
export function toE164(countryCode: string, number: string) {
  const digits = number.replace(/[\s().-]/g, "");
  return digits.startsWith("+")
    ? digits
    : `${countryCode.trim()}${digits.replace(/^0+/, "")}`;
}

/** What bookings_guest_phone_e164 accepts. */
export const E164 = /^[+][1-9][0-9]{7,14}$/;

const guestRequest = z
  .object({
    party: z
      .string(messages.choice)
      .regex(/^[0-9]{1,3}$/, messages.choice)
      .transform(Number)
      .refine((party) => party >= 1, messages.choice),
    date: z.string(messages.choice).refine(isLocalDate, messages.choice),
    time: z.string(messages.choice).regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, messages.choice),
    name: z
      .string(messages.name)
      .trim()
      .min(1, messages.name)
      .max(100, messages.name)
      .refine(noNul, messages.name),
    // Capped before anything reads them, so no pattern ever runs on a long string.
    // A country code is a + and at most four digits (E.164, ITU-T E.164).
    countryCode: z.string(messages.phone).max(8, messages.phone).default(DEFAULT_COUNTRY_CODE),
    // 15 digits at most, plus the spaces, dashes and brackets people type.
    phone: z.string(messages.phone).max(40, messages.phone),
    note: z
      .string(messages.note)
      .trim()
      .max(200, messages.note)
      .refine(noNul, messages.note)
      .optional(),
    consent: z.literal("on", messages.consent),
  })
  .transform(({ countryCode, phone, note, consent, ...rest }) => ({
    ...rest,
    phone: toE164(countryCode, phone),
    note: note || null,
    whatsappOptIn: consent === "on",
  }))
  .refine(({ phone }) => E164.test(phone), messages.phone);

export type GuestRequest = z.output<typeof guestRequest>;

export function parseGuestRequest(form: FormData) {
  const parsed = guestRequest.safeParse(Object.fromEntries(form));
  return parsed.success
    ? ({ success: true, data: parsed.data } as const)
    : ({ success: false, message: parsed.error.issues[0].message } as const);
}

// --- confirming -------------------------------------------------------------

export const dbErrorOf = (error: unknown) =>
  (error as { cause?: { code?: string; constraint?: string } } | null)?.cause;

/**
 * Drizzle's message quotes the statement's parameters, and on the guest's public
 * paths those are the manage token and the guest's phone: say only what failed.
 */
const failed = (what: string) => (error: unknown): never => {
  throw new Error(`${what} failed: ${dbErrorOf(error)?.code ?? "unknown"}`);
};

/**
 * Someone else got the table. 23P01 is the constraint saying so. 40P01 is the same
 * news: each of two inserts landing together sees the other's unfinished row and
 * waits for it, so Postgres ends that deadlock by failing one of them, and the
 * one it fails has lost that table just the same. So has a confirm that finds the
 * table archived or walk-ins only (bookings_table_live and bookings_table_bookable,
 * migration 0023): an owner changed it between the list and the insert.
 */
function tableWasTaken(error: unknown) {
  const cause = dbErrorOf(error);
  return (
    (cause?.code === "23P01" && cause.constraint === "bookings_no_overlap") ||
    (cause?.code === "23514" &&
      (cause.constraint === "bookings_table_live" || cause.constraint === "bookings_table_bookable")) ||
    cause?.code === "40P01"
  );
}

/**
 * Tries each table in turn and stops at the first that takes the insert, or gives
 * undefined if none does. A failed statement aborts the transaction it's in, and
 * every later statement with it, so each attempt gets a SAVEPOINT of its own (a
 * nested Drizzle transaction is one) and a refusal rolls back only that far. The
 * savepoints sit on withTenant's one connection, after its set_config, so the
 * tenant setting survives each rollback.
 */
export async function firstTableToTake<T>(
  tx: TenantTransaction,
  tableIds: readonly string[],
  insert: (attempt: TenantTransaction, tableId: string) => Promise<T>,
): Promise<T | undefined> {
  for (const tableId of tableIds) {
    try {
      return await tx.transaction((attempt) => insert(attempt, tableId));
    } catch (error) {
      if (!tableWasTaken(error)) throw error;
    }
  }
  return undefined;
}

export const raceLostMessage = "That time was just booked. Here are the nearest available times.";
export const leadTimeMessage =
  "That time is now too soon to book online. Here are the next available times.";
export const botCheckMessage = "We couldn't verify the request. Please try again.";
export const closedMessage = "This restaurant isn't taking online bookings right now.";
/** *(Proposed)* Spec 04 has no row for a date outside today to max_days_ahead. */
export const dateMessage = "That date can't be booked online. Choose another date.";
export const phoneLimitMessage = (held: number) =>
  `You already have ${held} upcoming ${held === 1 ? "booking" : "bookings"} here. Cancel one or contact the restaurant.`;
export const largePartyMessage = (threshold: number) =>
  `For groups of ${threshold}+, contact the restaurant`;

export type Confirmation = {
  restaurantName: string;
  dateLabel: string;
  time: string;
  party: number;
  manageToken: string;
  contactPhone: string | null;
};

export type ConfirmOutcome =
  | { outcome: "confirmed"; confirmation: Confirmation }
  | { outcome: "race_lost"; times: TimeChoice[] }
  | { outcome: "lead_time"; times: TimeChoice[] }
  | { outcome: "phone_limit"; held: number }
  | { outcome: "date_unavailable" }
  | {
      outcome: "party_too_large";
      threshold: number;
      contactPhone: string | null;
      whatsappLink: string | null;
    }
  | { outcome: "closed" };

/** The trigger in migration 0026 saying a closure now covers the time. */
export const isInsideClosure = (error: unknown) => {
  const cause = dbErrorOf(error);
  return cause?.code === "23514" && cause.constraint === "bookings_within_closure";
};

/** The trigger in migration 0024 saying this phone is at its limit. */
const isPhoneLimit = (error: unknown) => {
  const cause = dbErrorOf(error);
  return cause?.code === "23514" && cause.constraint === "bookings_max_active_per_phone";
};

/** Upcoming confirmed bookings under this number at this restaurant. */
async function upcomingFor(tx: TenantTransaction, { restaurantId }: Tenant, phone: string, now: Date) {
  const [{ held }] = await tx
    .select({ held: count() })
    .from(bookings)
    .where(
      and(
        eq(bookings.restaurantId, restaurantId),
        eq(bookings.guestPhone, phone),
        eq(bookings.status, "confirmed"),
        gt(bookings.startsAt, now),
      ),
    );
  return held;
}

/**
 * Confirms a booking, or says why not. Runs the same engine as the guest's list,
 * at the same instant, so a time the list would hide is refused here and one it
 * would show gets its tables tried. Whatever the list said a moment ago, Postgres
 * has the last word.
 *
 * The refusals come in the order a guest can act on them: a party that can't
 * book online, a date outside the booking window, a time inside the lead time, a
 * phone at its limit. Each has an answer of its own; a time that's gone for any
 * other reason, or was never on the grid, is the race-lost answer. The route runs
 * the rate limit and the bot check before any of this.
 *
 * The per-phone count here is for the guest's message. The rule is the trigger in
 * migration 0024, which serialises per phone: two confirms for one phone can't
 * both pass, and the one that loses is answered below as if the count had caught it.
 */
export async function confirmBooking(
  tenant: Tenant,
  guest: GuestRequest,
  now = new Date(),
): Promise<ConfirmOutcome> {
  const { party, date, time } = guest;
  try {
    return await withTenant(tenant, async (tx) => {
      const read = await readRules(tx, tenant);
      const { restaurant, rules } = read;
      const { timezone } = restaurant;
      if (!rules.enabled) return { outcome: "closed" };

      const threshold = await contactThreshold(tx, tenant, rules);
      if (party >= threshold) {
        return { outcome: "party_too_large", threshold, ...contactOf(restaurant.contactPhone) };
      }

      // Before any date arithmetic: a date like 9999-12-31 is a real date, and one
      // day after it isn't. Today and the last day are the restaurant's own.
      const today = localToday(now, timezone);
      if (date < today || date > addDays(today, rules.maxDaysAhead)) {
        return { outcome: "date_unavailable" };
      }

      const day = { party, date, now };
      const wanted = instantOf(date, time, timezone);
      if (wanted.getTime() < now.getTime() + rules.minLeadMinutes * 60_000) {
        const remaining = await timesOn(tx, tenant, read, day);
        return { outcome: "lead_time", times: choices(nearestTimes(remaining, wanted)) };
      }

      const held = await upcomingFor(tx, tenant, guest.phone, now);
      if (held >= rules.maxActiveBookingsPerPhone) return { outcome: "phone_limit", held };

      const chosen = (await timesOn(tx, tenant, read, day)).find((slot) => slot.time === time);
      const manageToken = mintQrToken();
      let booked: { id: string }[] | undefined;
      try {
        booked =
          chosen &&
          (await firstTableToTake(tx, chosen.tableIds, (attempt, tableId) =>
            attempt
              .insert(bookings)
              .values({
                restaurantId: tenant.restaurantId,
                tableId,
                guestName: guest.name,
                guestPhone: guest.phone,
                whatsappOptIn: guest.whatsappOptIn,
                partySize: party,
                ...holdFor(rules, party, chosen.startsAt),
                status: "confirmed",
                source: "online",
                guestNote: guest.note,
                manageToken,
              })
              .returning({ id: bookings.id }),
          ));
      } catch (error) {
        // A closure saved between the list and the insert (bookings_within_closure,
        // migration 0026) has taken the time away, for every table alike: the time is
        // gone, which is the race-lost answer. The attempt's savepoint is rolled back.
        if (isInsideClosure(error)) booked = undefined;
        else if (isPhoneLimit(error)) {
          // Lost the race for this phone's last place. The attempt's savepoint is
          // rolled back, so the transaction is whole, and a new statement now sees
          // whoever won.
          const heldNow = await upcomingFor(tx, tenant, guest.phone, now);
          return { outcome: "phone_limit", held: Math.max(heldNow, rules.maxActiveBookingsPerPhone) };
        } else throw error;
      }

      if (booked) {
        await queueBookingConfirmed(
          tx,
          { restaurantId: tenant.restaurantId, id: booked[0].id, guestPhone: guest.phone, whatsappOptIn: guest.whatsappOptIn, startsAt: chosen!.startsAt },
          now,
        );
        return {
          outcome: "confirmed",
          confirmation: {
            restaurantName: restaurant.name,
            dateLabel: dateLabel(date),
            time,
            party,
            manageToken,
            contactPhone: restaurant.contactPhone,
          },
        };
      }

      // Asked again, not reused: this statement's snapshot sees whoever just won.
      const remaining = await timesOn(tx, tenant, read, day);
      return { outcome: "race_lost", times: choices(nearestTimes(remaining, wanted)) };
    });
  } catch (error) {
    // A Drizzle error's message quotes the statement's parameters, which here are
    // the guest's phone and the manage token, and whatever is thrown gets logged.
    throw new Error(`confirming a booking failed: ${dbErrorOf(error)?.code ?? "unknown"}`);
  }
}

// --- the guest's manage page -----------------------------------------------

/**
 * The one definition of "the guest may still cancel": confirmed, and now() is no
 * later than the cutoff before the start. It is SQL so that the page's button and
 * the cancel itself can't disagree, and so the instant is the database's own clock,
 * never a time the client sent. Both sides are instants, so the restaurant's zone
 * has no part in it. The cutoff is read in the same statement, so a change to the
 * setting takes effect for the next cancel.
 */
const cancellableNow = sql<boolean>`(
  ${bookings.status} = 'confirmed'
  and now() <= ${bookings.startsAt} - make_interval(mins => (
    select ${bookingSettings.guestCancelCutoffMinutes} from ${bookingSettings}
    where ${bookingSettings.restaurantId} = ${bookings.restaurantId}
  ))
)`;

/**
 * What a guest may see of their own booking, and no more: no table, no phone, and
 * nothing of any other booking. The time is on the restaurant's clock.
 */
async function readManaged(tx: TenantTransaction, { restaurantId }: Tenant, token: string) {
  const [row] = await tx
    .select({
      guestName: bookings.guestName,
      party: bookings.partySize,
      startsAt: bookings.startsAt,
      note: bookings.guestNote,
      status: bookings.status,
      cancelledBy: bookings.cancelledBy,
      cancellable: cancellableNow,
    })
    .from(bookings)
    .where(and(eq(bookings.restaurantId, restaurantId), eq(bookings.manageToken, token)));
  if (!row) return undefined;
  const [restaurant] = await tx
    .select({
      name: restaurants.name,
      timezone: restaurants.timezone,
      contactPhone: restaurants.contactPhone,
    })
    .from(restaurants)
    .where(eq(restaurants.id, restaurantId));
  const { startsAt, ...rest } = row;
  return {
    ...rest,
    restaurantName: restaurant.name,
    contactPhone: restaurant.contactPhone,
    dateLabel: dateLabel(localToday(startsAt, restaurant.timezone)),
    time: localTime(startsAt, restaurant.timezone),
  };
}

export type ManagedBooking = NonNullable<Awaited<ReturnType<typeof readManaged>>>;

export function getManagedBooking(tenant: Tenant, token: string) {
  return withTenant(tenant, (tx) => readManaged(tx, tenant, token)).catch(failed("reading a booking"));
}

export type CancelOutcome =
  | { outcome: "cancelled" | "already_cancelled" | "too_late" | "not_cancellable"; booking: ManagedBooking }
  | { outcome: "not_found" };

/**
 * Cancels a booking for its guest, if they still may. One UPDATE guarded by the
 * status and the cutoff decides it, so a staff member who seats the guest at the
 * same moment can't be overwritten: the cancel waits on that row, then re-reads
 * it, sees `seated` and changes nothing. What it did is then worked out from the
 * row, so cancelling twice is safe and says so.
 *
 * A guest's cancel isn't audited: spec 01's list has staff's cancellations only,
 * and the row itself records `cancelled_by = guest` and when.
 */
export async function cancelBooking(tenant: Tenant, token: string): Promise<CancelOutcome> {
  return withTenant(tenant, async (tx): Promise<CancelOutcome> => {
    const cancelled = await tx
      .update(bookings)
      .set({ status: "cancelled", cancelledBy: "guest", cancelledAt: sql`now()` })
      .where(
        and(
          eq(bookings.restaurantId, tenant.restaurantId),
          eq(bookings.manageToken, token),
          cancellableNow,
        ),
      )
      .returning({
        id: bookings.id,
        guestPhone: bookings.guestPhone,
        whatsappOptIn: bookings.whatsappOptIn,
      });
    const booking = await readManaged(tx, tenant, token);
    if (!booking) return { outcome: "not_found" };
    if (cancelled.length > 0) {
      await queueBookingCancelled(tx, { restaurantId: tenant.restaurantId, ...cancelled[0] }, new Date());
      return { outcome: "cancelled", booking };
    }
    if (booking.status === "cancelled") return { outcome: "already_cancelled", booking };
    return { outcome: booking.status === "confirmed" ? "too_late" : "not_cancellable", booking };
  }).catch(failed("cancelling a booking"));
}
