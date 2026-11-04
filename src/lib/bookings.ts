import "server-only";
import { and, asc, eq, gt, gte, lt } from "drizzle-orm";
import { z } from "zod";
import {
  bookings,
  bookingSettings,
  diningTables,
  restaurants,
  servicePeriods,
} from "@/db/schema";
import {
  addDays,
  availableTimes,
  bookableDates,
  type AvailableTime,
  dateLabel,
  holdFor,
  instantOf,
  isLocalDate,
  type LocalDate,
  localTime,
  localToday,
  nearestTimes,
} from "@/lib/booking-engine";
import { mintQrToken } from "@/lib/qr-token";
import { type TenantContext, type TenantTransaction, withTenant } from "@/lib/tenant/scope";

/**
 * Bookings against the database: what /r/{slug}/book reads, the confirm, and the
 * staff day list. The rules are the engine's and Postgres's; this feeds one and
 * catches the other. On the public path, so it imports the tenant scope, not
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
 * restaurant's whole history; bookings_hold_capped (migration 0015) is what makes
 * that safe: no hold can be longer, however a booking is made.
 */
export const MAX_HOLD_MS = (720 + 240) * 60_000;

/** Everything about the restaurant the engine needs, bar the bookings. */
async function readRules(tx: TenantTransaction, { restaurantId }: Tenant) {
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

type ReadRules = Awaited<ReturnType<typeof readRules>>;

/** The one path to what can be seated: the guest's list and confirm both come here. */
async function timesOn(
  tx: TenantTransaction,
  { restaurantId }: Tenant,
  { rules, periods, restaurant: { timezone } }: ReadRules,
  { party, date, now }: { party: number; date: LocalDate; now: Date },
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
  return availableTimes({ party, date, rules, periods, tables, holds, timezone, now });
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
    const dates = bookableDates({ rules, periods, timezone, now }).map((day) => ({
      ...day,
      label: dateLabel(day.date),
    }));

    const party = /^[0-9]{1,3}$/.test(choice.party ?? "") ? Number(choice.party) : undefined;
    const chosenParty = party && party <= rules.maxOnlinePartySize ? party : undefined;
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
const noNul = (value: string) => !value.includes("\0");

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
    countryCode: z.string(messages.phone).default(DEFAULT_COUNTRY_CODE),
    phone: z.string(messages.phone),
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
  .refine(({ phone }) => /^[+][1-9][0-9]{7,14}$/.test(phone), messages.phone);

export type GuestRequest = z.output<typeof guestRequest>;

export function parseGuestRequest(form: FormData) {
  const parsed = guestRequest.safeParse(Object.fromEntries(form));
  return parsed.success
    ? ({ success: true, data: parsed.data } as const)
    : ({ success: false, message: parsed.error.issues[0].message } as const);
}

// --- confirming -------------------------------------------------------------

const dbErrorOf = (error: unknown) =>
  (error as { cause?: { code?: string; constraint?: string } } | null)?.cause;

/**
 * Someone else got the table. 23P01 is the constraint saying so. 40P01 is the same
 * news: each of two inserts landing together sees the other's unfinished row and
 * waits for it, so Postgres ends that deadlock by failing one of them, and the
 * one it fails has lost that table just the same. So has a confirm that finds the
 * table archived (bookings_table_live, migration 0016): an owner archived it
 * between the list and the insert.
 */
function tableWasTaken(error: unknown) {
  const cause = dbErrorOf(error);
  return (
    (cause?.code === "23P01" && cause.constraint === "bookings_no_overlap") ||
    (cause?.code === "23514" && cause.constraint === "bookings_table_live") ||
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

export const raceLostMessage = "That time was just booked — here are the nearest available times.";
export const closedMessage = "This restaurant isn't taking online bookings right now.";

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
  | { outcome: "closed" };

/**
 * Confirms a booking, or says why not. Runs the same engine as the guest's list,
 * at the same instant, so a time the list would hide is refused here and one it
 * would show gets its tables tried. Whatever the list said a moment ago, Postgres
 * has the last word.
 *
 * A time that's gone for any reason gets the race-lost answer for now. #33 adds
 * the refusals that come first (lead time, per-phone limit, bot check) and the
 * route's rate limit.
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

      const day = { party, date, now };
      const chosen = (await timesOn(tx, tenant, read, day)).find((slot) => slot.time === time);
      const manageToken = mintQrToken();
      const booked =
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

      if (booked) {
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
      const wanted = instantOf(date, time, timezone);
      return { outcome: "race_lost", times: choices(nearestTimes(remaining, wanted)) };
    });
  } catch (error) {
    // A Drizzle error's message quotes the statement's parameters, which here are
    // the guest's phone and the manage token, and whatever is thrown gets logged.
    throw new Error(`confirming a booking failed: ${dbErrorOf(error)?.code ?? "unknown"}`);
  }
}

// --- the staff day list -----------------------------------------------------

/** Today's bookings on the restaurant's calendar, by time. */
export function listTodaysBookings(tenant: Tenant, now = new Date()) {
  return withTenant(tenant, async (tx) => {
    const [{ timezone }] = await tx
      .select({ timezone: restaurants.timezone })
      .from(restaurants)
      .where(eq(restaurants.id, tenant.restaurantId));
    const today = localToday(now, timezone);
    const rows = await tx
      .select({
        id: bookings.id,
        startsAt: bookings.startsAt,
        guestName: bookings.guestName,
        partySize: bookings.partySize,
        table: diningTables.label,
        status: bookings.status,
      })
      .from(bookings)
      .innerJoin(
        diningTables,
        and(
          eq(diningTables.restaurantId, bookings.restaurantId),
          eq(diningTables.id, bookings.tableId),
        ),
      )
      .where(
        and(
          eq(bookings.restaurantId, tenant.restaurantId),
          gte(bookings.startsAt, instantOf(today, "00:00", timezone)),
          lt(bookings.startsAt, instantOf(addDays(today, 1), "00:00", timezone)),
        ),
      )
      .orderBy(asc(bookings.startsAt), asc(diningTables.label));
    return {
      dateLabel: dateLabel(today),
      bookings: rows.map(({ startsAt, ...row }) => ({
        ...row,
        time: localTime(startsAt, timezone),
      })),
    };
  });
}
