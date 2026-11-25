import "server-only";
import { and, asc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { notFound } from "next/navigation";
import { z } from "zod";
import { bookingSettings, diningTables, restaurants, servicePeriods } from "@/db/schema";
import { revalidateMenu } from "@/lib/menu-cache";
import { type TenantContext, withTenant } from "@/lib/tenant";
import { recordAdminAction } from "@/lib/tenant/audit";

/**
 * Online booking settings and service periods (spec 04 › Settings), owner only
 * (S-26): callers check requireOwner(ctx). Spec 01's audit list has booking
 * cancellations and moves, not settings, so only a platform admin's writes are
 * audited, as for restaurant settings.
 *
 * The rules that matter are Postgres's: the times check, the no-overlap
 * constraint and the enable gate (migration 0021). The checks here only give an
 * owner the sentence the constraint would otherwise refuse with.
 */

type Tenant = Pick<TenantContext, "restaurantId">;
type Writer = Tenant & Pick<TenantContext, "platformAdminId">;

// --- the settings -----------------------------------------------------------

/** One whole-number setting: bounds as in the table's CHECKs (booking_settings_*). */
const numbers = {
  slotIntervalMinutes: { label: "Time between bookable slots, in minutes", min: 1, max: 240, help: "How far apart the times guests can pick are. 15 gives 18:00, 18:15, 18:30." },
  sittingMinutes: { label: "Sitting length, in minutes", min: 1, max: 720, help: "How long a table is kept for a party smaller than the large party size." },
  largePartySize: { label: "Large party size", min: 1, max: 100, help: "A party this size or bigger gets the large party sitting." },
  largePartySittingMinutes: { label: "Large party sitting length, in minutes", min: 1, max: 720, help: "How long a table is kept for a large party. Usually longer than the normal sitting." },
  bufferMinutes: { label: "Buffer between bookings, in minutes", min: 0, max: 240, help: "Time kept free after each sitting to reset the table." },
  minLeadMinutes: { label: "Lead time, in minutes", min: 0, max: 10080, help: "Guests can't book a time that is closer than this. 60 means no bookings in the next hour." },
  maxDaysAhead: { label: "Days ahead guests can book", min: 0, max: 365, help: "How far ahead guests can book. 0 means today only." },
  maxOnlinePartySize: { label: "Largest party that can book online", min: 1, max: 100, help: "Bigger parties are asked to contact the restaurant." },
  guestCancelCutoffMinutes: { label: "Cancellation cutoff, in minutes", min: 0, max: 10080, help: "Guests can cancel online until this long before the booking. It applies to bookings already made too." },
  maxActiveBookingsPerPhone: { label: "Upcoming bookings allowed per phone number", min: 1, max: 20, help: "How many upcoming bookings one phone number can hold at a time." },
} as const;

export type BookingSettingKey = keyof typeof numbers;

/** What the form shows for each setting, in order. */
export const settingFields = (Object.keys(numbers) as BookingSettingKey[]).map((key) => ({
  key,
  ...numbers[key],
}));

/**
 * What a save asks about first (lib/confirmation.ts). A large party's sitting
 * shorter than a small party's is allowed, but it is almost always a slip.
 */
export function ruleWarnings(values: BookingSettingsValues): string[] {
  return values.largePartySittingMinutes < values.sittingMinutes
    ? [
        `Parties of ${values.largePartySize} or more would get ${values.largePartySittingMinutes} minutes, less than the ${values.sittingMinutes} minutes smaller parties get.`,
      ]
    : [];
}

/** What a save of the rules changes for bookings already made: only the cancel cutoff. */
export const rulesSavedMessage =
  "Saved. The new rules apply to bookings made from now on, except the cancellation cutoff, which applies to every upcoming booking, including ones already made.";

// Messages are fixed strings, so a refused value is never echoed back.
const numberField = ({ label, min, max }: (typeof numbers)[BookingSettingKey]) => {
  const message = `${label}: enter a whole number from ${min} to ${max}.`;
  return (
    z
      .string(message)
      .trim()
      // Digits only: Number("1e1") and Number("0x10") would pass as numbers.
      .regex(/^[0-9]{1,6}$/, message)
      .transform(Number)
      .refine((n) => n >= min && n <= max, message)
  );
};

const settingsForm = z.object(
  Object.fromEntries(
    (Object.keys(numbers) as BookingSettingKey[]).map((key) => [key, numberField(numbers[key])]),
  ) as { [K in BookingSettingKey]: ReturnType<typeof numberField> },
);

export type BookingSettingsValues = z.output<typeof settingsForm>;

const firstMessage = (error: z.ZodError) => error.issues[0].message;

export function parseBookingSettings(form: FormData) {
  const parsed = settingsForm.safeParse(Object.fromEntries(form));
  return parsed.success
    ? ({ success: true, data: parsed.data } as const)
    : ({ success: false, message: firstMessage(parsed.error) } as const);
}

export async function getBookingSettings(ctx: Tenant) {
  const [row] = await withTenant(ctx, (tx) =>
    tx
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
        guestCancelCutoffMinutes: bookingSettings.guestCancelCutoffMinutes,
        maxActiveBookingsPerPhone: bookingSettings.maxActiveBookingsPerPhone,
      })
      .from(bookingSettings)
      .where(eq(bookingSettings.restaurantId, ctx.restaurantId)),
  );
  return row;
}

/**
 * Saves the numbers. `enabled` isn't among them: turning booking on or off is
 * setBookingEnabled, because that one has a gate.
 */
export async function updateBookingSettings(ctx: Writer, values: BookingSettingsValues) {
  await withTenant(ctx, async (tx) => {
    const updated = await tx
      .update(bookingSettings)
      .set(values)
      .where(eq(bookingSettings.restaurantId, ctx.restaurantId))
      .returning({ restaurantId: bookingSettings.restaurantId });
    // A trigger makes the row with the restaurant, so this is a broken database.
    if (updated.length === 0) throw new Error("the restaurant has no booking_settings row");
    await recordAdminAction(tx, ctx, {
      action: "booking_settings.update",
      entityType: "booking_settings",
      entityId: ctx.restaurantId,
    });
  });
}

// --- the enable gate --------------------------------------------------------

/** What has to exist before booking can be turned on. The names Postgres's gate reports. */
export type GateItem = "service_period" | "table" | "contact_phone";

export const gateMessages: Record<GateItem, string> = {
  service_period: "add at least one service period",
  table: "add a table that can be booked online",
  contact_phone: "set the restaurant's contact phone in Restaurant settings",
};

/** Where each gate item is fixed: the periods are on this page. */
export const gateLinks: Record<GateItem, { href: string; label: string }> = {
  service_period: { href: "#service-periods", label: "Go to service periods" },
  table: { href: "/dashboard/tables", label: "Go to tables" },
  contact_phone: { href: "/dashboard/settings", label: "Go to Restaurant settings" },
};

/** The sentence a refusal to enable carries. */
export const enableBlockedMessage = (missing: readonly GateItem[]) =>
  `Online booking can't be turned on yet: ${missing.map((item) => gateMessages[item]).join(", ")}.`;

const gateItems = new Set<string>(Object.keys(gateMessages));

const dbErrorOf = (error: unknown) =>
  (error as { cause?: { constraint?: string; detail?: string } } | null)?.cause;

/**
 * Turns online booking on or off. The gate is Postgres's, not a check here:
 * a trigger refuses to enable while a service period, a bookable table or the
 * contact phone is missing, and it runs under the settings row's lock, so a table
 * archived at the same moment can't slip past it (see migration 0021). The
 * refusal names what's missing.
 */
export async function setBookingEnabled(
  ctx: Writer,
  enabled: boolean,
): Promise<{ outcome: "saved" } | { outcome: "blocked"; missing: GateItem[] }> {
  try {
    await withTenant(ctx, async (tx) => {
      await tx
        .update(bookingSettings)
        .set({ enabled })
        .where(eq(bookingSettings.restaurantId, ctx.restaurantId));
      await recordAdminAction(tx, ctx, {
        action: enabled ? "booking.enable" : "booking.disable",
        entityType: "booking_settings",
        entityId: ctx.restaurantId,
      });
    });
  } catch (error) {
    const cause = dbErrorOf(error);
    if (cause?.constraint === "booking_settings_enable_gate") {
      const missing = (cause.detail ?? "")
        .split(",")
        .filter((item): item is GateItem => gateItems.has(item));
      return { outcome: "blocked", missing };
    }
    throw error;
  }
  // After commit: the table page's "Book again" depends on this (spec 03). The
  // gate's own switch-off runs in Postgres and never gets here, so that page
  // catches up on its 5-minute revalidation instead.
  revalidateMenu(ctx);
  return { outcome: "saved" };
}

/**
 * What the screen lists as still to do. Display only: it reads what the screen
 * already shows, and Postgres decides at the moment of enabling.
 */
export function missingForBooking(have: {
  periods: number;
  bookableTables: number;
  contactPhone: string | null;
}): GateItem[] {
  return [
    ...(have.periods === 0 ? (["service_period"] as const) : []),
    ...(have.bookableTables === 0 ? (["table"] as const) : []),
    ...(have.contactPhone ? [] : (["contact_phone"] as const)),
  ];
}

/** The live bookable tables and the contact phone: the other halves of the gate. */
export function getBookingReadiness(ctx: Tenant) {
  return withTenant(ctx, async (tx) => {
    const [tables] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(diningTables)
      .where(
        and(
          eq(diningTables.restaurantId, ctx.restaurantId),
          eq(diningTables.bookable, true),
          isNull(diningTables.archivedAt),
        ),
      );
    const [restaurant] = await tx
      .select({
        contactPhone: restaurants.contactPhone,
        timezone: restaurants.timezone,
        slug: restaurants.slug,
      })
      .from(restaurants)
      .where(eq(restaurants.id, ctx.restaurantId));
    return { bookableTables: tables.count, ...restaurant };
  });
}

// --- service periods --------------------------------------------------------

export const weekdayNames = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** The screen's order: Monday first, as a week reads. */
export const weekdayOrder = [1, 2, 3, 4, 5, 6, 0] as const;

const periodMessages = {
  name: "Enter a name for the period, like Lunch, up to 50 characters.",
  weekday: "Choose a day of the week.",
  time: "Enter the times as hours and minutes, like 12:00.",
  order:
    "The opening time can't be after the last booking time, and the last booking has to be before closing.",
  overlap: "That overlaps another service period on the same day.",
};

export const periodOverlapMessage = periodMessages.overlap;
export const periodOrderMessage = periodMessages.order;

// <input type="time"> sends HH:MM. A period can't cross midnight, so 23:59 is the latest.
const timeOfDay = z
  .string(periodMessages.time)
  .trim()
  .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, periodMessages.time);

const periodFields = {
  name: z
    .string(periodMessages.name)
    .trim()
    .min(1, periodMessages.name)
    .max(50, periodMessages.name),
  opensAt: timeOfDay,
  lastBookingAt: timeOfDay,
  closesAt: timeOfDay,
};

const periodOrdered = (p: { opensAt: string; lastBookingAt: string; closesAt: string }) =>
  p.opensAt <= p.lastBookingAt && p.lastBookingAt < p.closesAt;

const periodEdit = z
  .object(periodFields)
  .refine(periodOrdered, { message: periodMessages.order });

const newPeriod = z
  .object({
    ...periodFields,
    weekday: z
      .string(periodMessages.weekday)
      .regex(/^[0-6]$/, periodMessages.weekday)
      .transform(Number),
  })
  .refine(periodOrdered, { message: periodMessages.order });

export type PeriodEdit = z.output<typeof periodEdit>;
export type NewPeriod = z.output<typeof newPeriod>;

export function parseNewPeriod(form: FormData) {
  const parsed = newPeriod.safeParse(Object.fromEntries(form));
  return parsed.success
    ? ({ success: true, data: parsed.data } as const)
    : ({ success: false, message: firstMessage(parsed.error) } as const);
}

export function parsePeriodEdit(form: FormData) {
  const parsed = periodEdit.safeParse(Object.fromEntries(form));
  return parsed.success
    ? ({ success: true, data: parsed.data } as const)
    : ({ success: false, message: firstMessage(parsed.error) } as const);
}

/** The id in a period route. A malformed one is a 404, like an unknown one. */
export async function periodIdFrom(params: Promise<{ periodId: string }>) {
  const parsed = z.uuid().safeParse((await params).periodId);
  if (!parsed.success) notFound();
  return parsed.data;
}

const OVERLAP = "service_periods_no_overlap";
const ORDER = "service_periods_times_ordered";

export type PeriodChange = "saved" | "overlaps" | "invalid_times" | "not_found";

/** Postgres's refusal of a period, as an outcome. Anything else is a real error. */
function refusalOf(error: unknown): PeriodChange {
  const constraint = dbErrorOf(error)?.constraint;
  if (constraint === OVERLAP) return "overlaps";
  if (constraint === ORDER || constraint === "service_periods_same_day") return "invalid_times";
  throw error;
}

/** Times of day as "HH:MM": Postgres's `time` comes back as "HH:MM:SS". */
const hoursAndMinutes = (time: string) => time.slice(0, 5);

/**
 * A restaurant's periods, by weekday and then opening time. The times are the
 * restaurant's wall clock: restaurants.timezone says which instant that is.
 */
export function listServicePeriods(ctx: Tenant) {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: servicePeriods.id,
        name: servicePeriods.name,
        weekday: servicePeriods.weekday,
        opensAt: servicePeriods.opensAt,
        lastBookingAt: servicePeriods.lastBookingAt,
        closesAt: servicePeriods.closesAt,
      })
      .from(servicePeriods)
      .where(eq(servicePeriods.restaurantId, ctx.restaurantId))
      .orderBy(asc(servicePeriods.weekday), asc(servicePeriods.opensAt));
    return rows.map((row) => ({
      ...row,
      opensAt: hoursAndMinutes(row.opensAt),
      lastBookingAt: hoursAndMinutes(row.lastBookingAt),
      closesAt: hoursAndMinutes(row.closesAt),
    }));
  });
}

export async function addServicePeriod(
  ctx: Writer,
  period: NewPeriod,
): Promise<"saved" | "overlaps" | "invalid_times"> {
  try {
    return await withTenant(ctx, async (tx) => {
      const [added] = await tx
        .insert(servicePeriods)
        .values({ ...period, restaurantId: ctx.restaurantId })
        .returning({ id: servicePeriods.id });
      await recordAdminAction(tx, ctx, {
        action: "service_period.create",
        entityType: "service_period",
        entityId: added.id,
      });
      return "saved" as const;
    });
  } catch (error) {
    return refusalOf(error) as "overlaps" | "invalid_times";
  }
}

export async function updateServicePeriod(
  ctx: Writer,
  periodId: string,
  edit: PeriodEdit,
): Promise<PeriodChange> {
  try {
    return await withTenant(ctx, async (tx) => {
      const updated = await tx
        .update(servicePeriods)
        .set(edit)
        .where(
          and(eq(servicePeriods.restaurantId, ctx.restaurantId), eq(servicePeriods.id, periodId)),
        )
        .returning({ id: servicePeriods.id });
      if (updated.length === 0) return "not_found" as const;
      await recordAdminAction(tx, ctx, {
        action: "service_period.update",
        entityType: "service_period",
        entityId: periodId,
      });
      return "saved" as const;
    });
  } catch (error) {
    return refusalOf(error);
  }
}

/**
 * Deletes a period. Nothing refers to one, so it's gone for good. If it was the
 * restaurant's last, Postgres switches online booking off with it.
 */
export function deleteServicePeriod(ctx: Writer, periodId: string): Promise<"saved" | "not_found"> {
  return withTenant(ctx, async (tx) => {
    const deleted = await tx
      .delete(servicePeriods)
      .where(
        and(eq(servicePeriods.restaurantId, ctx.restaurantId), eq(servicePeriods.id, periodId)),
      )
      .returning({ id: servicePeriods.id });
    if (deleted.length === 0) return "not_found" as const;
    await recordAdminAction(tx, ctx, {
      action: "service_period.delete",
      entityType: "service_period",
      entityId: periodId,
    });
    return "saved" as const;
  });
}

// --- copying a period to other days -----------------------------------------

/** The weekdays ticked on a copy form: whole numbers 0 to 6, each once. */
export function parseCopyDays(form: FormData) {
  const days = form.getAll("weekdays");
  const parsed = z
    .array(z.string().regex(/^[0-6]$/))
    .min(1, "Choose the days to copy it to.")
    .safeParse(days);
  return parsed.success
    ? ({ success: true, data: [...new Set(parsed.data.map(Number))] } as const)
    : ({ success: false, message: "Choose the days to copy it to." } as const);
}

export type CopyOutcome =
  | { outcome: "saved"; copied: number }
  | { outcome: "not_found" }
  | { outcome: "no_days" }
  | {
      outcome: "overlaps";
      source?: { name: string; opensAt: string; closesAt: string };
      clashes: { weekday: number; name: string }[];
    };

/**
 * Copies one period (name and times) to other weekdays, all or none: if any
 * chosen day already has a period overlapping it, nothing is copied and the
 * clashes come back. The same check is Postgres's exclusion constraint, which
 * also settles two copies racing, and rolls the whole copy back. The source is
 * read by restaurant and id, so another restaurant's period is "not found".
 */
export async function copyServicePeriod(
  ctx: Writer,
  periodId: string,
  weekdays: readonly number[],
): Promise<CopyOutcome> {
  try {
    return await withTenant(ctx, async (tx): Promise<CopyOutcome> => {
      const [source] = await tx
        .select()
        .from(servicePeriods)
        .where(
          and(eq(servicePeriods.restaurantId, ctx.restaurantId), eq(servicePeriods.id, periodId)),
        );
      if (!source) return { outcome: "not_found" };
      const targets = weekdays.filter((weekday) => weekday !== source.weekday);
      if (targets.length === 0) return { outcome: "no_days" };

      const clashes = await tx
        .select({ weekday: servicePeriods.weekday, name: servicePeriods.name })
        .from(servicePeriods)
        .where(
          and(
            eq(servicePeriods.restaurantId, ctx.restaurantId),
            inArray(servicePeriods.weekday, targets),
            lt(servicePeriods.opensAt, source.closesAt),
            gt(servicePeriods.closesAt, source.opensAt),
          ),
        );
      if (clashes.length > 0) {
        return {
          outcome: "overlaps",
          source: {
            name: source.name,
            opensAt: hoursAndMinutes(source.opensAt),
            closesAt: hoursAndMinutes(source.closesAt),
          },
          clashes: clashes.sort(
            (a, b) => weekdayOrder.indexOf(a.weekday as 0) - weekdayOrder.indexOf(b.weekday as 0),
          ),
        };
      }

      const added = await tx
        .insert(servicePeriods)
        .values(
          targets.map((weekday) => ({
            restaurantId: ctx.restaurantId,
            weekday,
            name: source.name,
            opensAt: source.opensAt,
            lastBookingAt: source.lastBookingAt,
            closesAt: source.closesAt,
          })),
        )
        .returning({ id: servicePeriods.id });
      for (const { id } of added) {
        await recordAdminAction(tx, ctx, {
          action: "service_period.create",
          entityType: "service_period",
          entityId: id,
        });
      }
      return { outcome: "saved", copied: added.length };
    });
  } catch (error) {
    // Two copies at once: the constraint refused one, and the copy rolled back whole.
    if (dbErrorOf(error)?.constraint === OVERLAP) return { outcome: "overlaps", clashes: [] };
    throw error;
  }
}

/** The 409's sentence: says nothing was copied, and which days are in the way. */
export function copyOverlapMessage(outcome: Extract<CopyOutcome, { outcome: "overlaps" }>) {
  const { source, clashes } = outcome;
  if (!source || clashes.length === 0) {
    return "Nothing was copied: a chosen day already has a period that overlaps it. Try again.";
  }
  return `Nothing was copied. ${source.name} (${source.opensAt} to ${source.closesAt}) overlaps a period already on ${clashes
    .map((clash) => `${weekdayNames[clash.weekday]} (${clash.name})`)
    .join(", ")}. Change or delete that period, or leave the day out.`;
}
