import "server-only";
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { menuItems, restaurants, specials } from "@/db/schema";
import { optionalPrice } from "@/lib/menu";
import { revalidateMenu } from "@/lib/menu-cache";
import { recordAdminAction } from "@/lib/tenant/audit";
import { type TenantContext, withTenant } from "@/lib/tenant/scope";

/**
 * Promotions (spec 02 › Specials): an existing item at a special price, or just
 * a badge, for a window. Owner only (S-26): callers check requireOwner(ctx). The
 * item's own prices never change, and what a special does to a price is in
 * "@/lib/pricing". Every write calls revalidateMenu, so a route can't forget to.
 *
 * Postgres holds D-05 (`specials_no_overlap`): two active specials on one item
 * can't overlap, and this file only turns that refusal into an answer.
 */

type Writer = Pick<TenantContext, "restaurantId" | "platformAdminId">;

const CHECK_VIOLATION = "23514";
const EXCLUSION_VIOLATION = "23P01";

const errorCode = (error: unknown) =>
  (error as { cause?: { code?: string } }).cause?.code;
const errorConstraint = (error: unknown) =>
  (error as { cause?: { constraint?: string } }).cause?.constraint;

const messages = {
  item: "Choose an item.",
  title: "Enter a badge of up to 80 characters, like Taco Tuesday.",
  priceUsd: "Enter the special USD price as a number, like 6.50.",
  priceZig: "Enter the special ZiG price as a number, like 150.",
  nothing: "Enter a badge, a special price, or both.",
  date: "Enter the date as year-month-day, like 2026-11-30.",
  order: "The end date can't be before the start date.",
  active: "Choose on or off.",
};

export const overlapMessage =
  "That item already has an active special in some of those dates. Turn the other off, or change the dates.";

export const alreadyOverMessage = "That end date has passed. Choose today or later.";

const optionalText = (message: string, max: number) =>
  z.preprocess(
    (value) => (value === undefined ? "" : value),
    z
      .string(message)
      .trim()
      .max(max, message)
      .transform((value) => value || null),
  );

/** A calendar date, as <input type="date"> sends it. Blank is no date. */
const optionalDate = z.preprocess(
  (value) => (value === undefined ? "" : value),
  z
    .string(messages.date)
    .trim()
    .refine((value) => {
      if (value === "") return true;
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
      if (!match) return false;
      const [year, month, day] = match.slice(1).map(Number);
      const made = new Date(Date.UTC(year, month - 1, day));
      return (
        year >= 2000 &&
        year <= 2100 &&
        made.getUTCFullYear() === year &&
        made.getUTCMonth() === month - 1 &&
        made.getUTCDate() === day
      );
    }, messages.date)
    .transform((value) => value || null),
);

const newSpecial = z
  .object({
    // Whether it's a live item of this restaurant is createSpecial's question,
    // so another restaurant's id gets the 404 an unknown one does.
    menuItemId: z.string(messages.item).min(1, messages.item),
    title: optionalText(messages.title, 80),
    priceUsd: optionalPrice(/^[0-9]{1,6}(\.[0-9]{1,2})?$/, messages.priceUsd),
    priceZig: optionalPrice(/^[0-9]{1,9}(\.[0-9]{1,2})?$/, messages.priceZig),
    startDate: optionalDate,
    endDate: optionalDate,
  })
  // The database refuses these too: this gives the reason.
  .refine(
    ({ title, priceUsd, priceZig }) => title !== null || priceUsd !== null || priceZig !== null,
    { message: messages.nothing, path: ["title"] },
  )
  .refine(
    // ISO dates sort as text.
    ({ startDate, endDate }) => startDate === null || endDate === null || endDate >= startDate,
    { message: messages.order, path: ["endDate"] },
  );

const newActive = z.object({
  active: z.enum(["true", "false"], messages.active),
});

export type NewSpecial = z.output<typeof newSpecial>;

export const parseNewSpecial = (form: FormData) => {
  const result = newSpecial.safeParse(Object.fromEntries(form));
  return result.success
    ? ({ success: true, data: result.data } as const)
    : ({ success: false, message: result.error.issues[0].message } as const);
};

export const parseSpecialActive = (form: FormData) => {
  const result = newActive.safeParse(Object.fromEntries(form));
  return result.success
    ? ({ success: true, data: result.data.active === "true" } as const)
    : ({ success: false, message: result.error.issues[0].message } as const);
};

const isId = (id: string) => z.uuid().safeParse(id).success;

/**
 * A date in the restaurant's timezone as an instant. A start date opens at that
 * day's midnight. An end date is inclusive ("until Sunday" runs through Sunday),
 * so the window closes at the midnight after it; the window is half-open, so a
 * special that starts the next day follows without a gap or an overlap. Done in
 * Postgres, which knows the zone's rules for that day, not the server's.
 */
const zone = (restaurantId: string) =>
  sql`(select ${restaurants.timezone} from ${restaurants} where ${restaurants.id} = ${restaurantId})`;
const startOfDay = (date: string, restaurantId: string) =>
  sql`(${date}::date)::timestamp at time zone ${zone(restaurantId)}`;
const startOfNextDay = (date: string, restaurantId: string) =>
  sql`((${date}::date + 1)::timestamp at time zone ${zone(restaurantId)})`;

/**
 * Adds a promotion for a live item. A blank start is the moment of saving, as
 * spec 02 says, not an open lower end: an open one would overlap every special
 * that is over, since those stay active. "overlap" is D-05: the item already has
 * an active special in some of those dates. "already_over" is a blank start with
 * an end date in the past, which leaves no window. An archived item or another
 * restaurant's is "no_such_item".
 */
export async function createSpecial(
  ctx: Writer,
  { menuItemId, title, priceUsd, priceZig, startDate, endDate }: NewSpecial,
): Promise<"saved" | "no_such_item" | "overlap" | "already_over"> {
  if (!isId(menuItemId)) return "no_such_item";

  const { restaurantId } = ctx;
  try {
    const added = await withTenant(ctx, async (tx) => {
      const [item] = await tx
        .select({ id: menuItems.id })
        .from(menuItems)
        .where(
          and(
            eq(menuItems.restaurantId, restaurantId),
            eq(menuItems.id, menuItemId),
            isNull(menuItems.archivedAt),
          ),
        );
      if (!item) return null;

      const [row] = await tx
        .insert(specials)
        .values({
          restaurantId,
          menuItemId,
          title,
          specialPriceUsd: priceUsd,
          specialPriceZig: priceZig,
          startsAt: startDate === null ? sql`now()` : startOfDay(startDate, restaurantId),
          endsAt: endDate === null ? null : startOfNextDay(endDate, restaurantId),
        })
        .returning({ id: specials.id });
      await recordAdminAction(tx, ctx, {
        action: "special.create",
        entityType: "special",
        entityId: row.id,
      });
      return row;
    });
    if (!added) return "no_such_item";
  } catch (error) {
    if (errorCode(error) === EXCLUSION_VIOLATION) return "overlap";
    // The form has already put typed dates in order, so only a blank start gets here.
    if (errorConstraint(error) === "specials_window_ordered") return "already_over";
    // The form checks these first; this is the backstop.
    if (errorCode(error) === CHECK_VIOLATION) return "no_such_item";
    throw error;
  }
  revalidateMenu(ctx);
  return "saved";
}

/**
 * Turns a special on or off. Turning it on again can meet D-05 (another active
 * special took its dates meanwhile), which is "overlap". The special of an
 * archived item, or of another restaurant, is "not_found".
 */
export async function setSpecialActive(
  ctx: Writer,
  specialId: string,
  active: boolean,
): Promise<"saved" | "not_found" | "overlap"> {
  if (!isId(specialId)) return "not_found";

  const { restaurantId } = ctx;
  try {
    const saved = await withTenant(ctx, async (tx) => {
      const [live] = await tx
        .select({ id: specials.id })
        .from(specials)
        .innerJoin(
          menuItems,
          and(
            eq(menuItems.restaurantId, specials.restaurantId),
            eq(menuItems.id, specials.menuItemId),
          ),
        )
        .where(
          and(
            eq(specials.restaurantId, restaurantId),
            eq(specials.id, specialId),
            isNull(menuItems.archivedAt),
          ),
        );
      if (!live) return false;

      await tx
        .update(specials)
        .set({ active })
        .where(and(eq(specials.restaurantId, restaurantId), eq(specials.id, specialId)));
      await recordAdminAction(tx, ctx, {
        action: "special.toggle",
        entityType: "special",
        entityId: specialId,
        details: { active },
      });
      return true;
    });
    if (!saved) return "not_found";
  } catch (error) {
    if (errorCode(error) === EXCLUSION_VIOLATION) return "overlap";
    throw error;
  }
  revalidateMenu(ctx);
  return "saved";
}

/** A calendar date in `timeZone` as year-month-day. */
const calendarDate = (instant: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);

/**
 * The dates an owner typed, back from the stored instants. The end instant is
 * the midnight after the last day, so the last day is the one a moment earlier.
 */
export function windowDates(
  { startsAt, endsAt }: { startsAt: Date | null; endsAt: Date | null },
  timeZone: string,
) {
  return {
    startDate: startsAt === null ? null : calendarDate(startsAt, timeZone),
    endDate:
      endsAt === null ? null : calendarDate(new Date(endsAt.getTime() - 1), timeZone),
  };
}

export type SpecialStatus = "live" | "scheduled" | "ended" | "off";

/** What the owner is told about a special. Only the first is on the customer's page. */
export function specialStatus(
  { active, startsAt, endsAt }: { active: boolean; startsAt: Date | null; endsAt: Date | null },
  now: Date,
): SpecialStatus {
  if (!active) return "off";
  if (startsAt !== null && startsAt > now) return "scheduled";
  if (endsAt !== null && endsAt <= now) return "ended";
  return "live";
}

const statusOrder: SpecialStatus[] = ["live", "scheduled", "off", "ended"];

/** How many specials that are over or turned off the owner's list keeps. */
export const FINISHED_SPECIALS_LISTED = 20;

/**
 * The specials of live items, for the owner's list: live ones first, then those
 * still to start, those turned off, and those over. Nothing deletes a special, so
 * the last two only grow, and only the latest of them are read: by when they
 * end, or start if they have no end. A special of an archived item is left out,
 * as its item is.
 */
export function listSpecials(ctx: Pick<TenantContext, "restaurantId">, now = new Date()) {
  const { restaurantId } = ctx;
  return withTenant(ctx, async (tx) => {
    const sameItem = and(
      eq(menuItems.restaurantId, specials.restaurantId),
      eq(menuItems.id, specials.menuItemId),
    );
    const listable = and(eq(specials.restaurantId, restaurantId), isNull(menuItems.archivedAt));
    const latestFinished = tx
      .select({ id: specials.id })
      .from(specials)
      .innerJoin(menuItems, sameItem)
      .where(and(listable, or(eq(specials.active, false), lte(specials.endsAt, now))))
      .orderBy(
        sql`coalesce(${specials.endsAt}, ${specials.startsAt}) desc nulls last`,
        desc(specials.id),
      )
      .limit(FINISHED_SPECIALS_LISTED);

    const rows = await tx
      .select({
        id: specials.id,
        itemName: menuItems.name,
        title: specials.title,
        priceUsd: specials.specialPriceUsd,
        priceZig: specials.specialPriceZig,
        startsAt: specials.startsAt,
        endsAt: specials.endsAt,
        active: specials.active,
        timezone: restaurants.timezone,
      })
      .from(specials)
      .innerJoin(menuItems, sameItem)
      .innerJoin(restaurants, eq(restaurants.id, specials.restaurantId))
      .where(
        and(
          listable,
          or(
            and(
              eq(specials.active, true),
              or(isNull(specials.endsAt), gt(specials.endsAt, now)),
            ),
            inArray(specials.id, latestFinished),
          ),
        ),
      )
      .orderBy(asc(menuItems.name), asc(specials.startsAt));

    return rows
      .map(({ startsAt, endsAt, timezone, ...row }) => ({
        ...row,
        ...windowDates({ startsAt, endsAt }, timezone),
        status: specialStatus({ active: row.active, startsAt, endsAt }, now),
      }))
      .sort((a, b) => statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status));
  });
}
