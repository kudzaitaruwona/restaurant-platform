import "server-only";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { bookingSettings, currencyMode, restaurants } from "@/db/schema";
import { DEFAULT_COUNTRY_CODE } from "@/lib/bookings";
import { revalidateMenu } from "@/lib/menu-cache";
import { type SpecialAbove, specialsAbove } from "@/lib/special-price-refusal";
import { type TenantContext, type TenantTransaction, withTenant } from "@/lib/tenant";
import { DEFAULT_TIMEZONE } from "@/lib/tenant/platform-admin";
import { recordAdminAction } from "@/lib/tenant/audit";

/**
 * Restaurant settings, owner only (S-26): callers check requireOwner(ctx).
 * Holds the Wi-Fi password, so nothing here logs or audits the values. Settings
 * edits aren't on spec 01's audit list, so only a platform admin's are recorded.
 */

type Tenant = Pick<TenantContext, "restaurantId">;

/**
 * Every zone the settings page and the New restaurant sheet offer, in one list
 * worked out once (checking each builds a DateTimeFormat, hundreds in all). Varies
 * with the runtime's ICU data, so the default and UTC are always among them.
 */
export const timezoneChoices = (): readonly string[] =>
  (choices ??= [
    ...new Set([DEFAULT_TIMEZONE, "UTC", ...Intl.supportedValuesOf("timeZone")].filter(isTimeZone)),
  ].sort());

let choices: readonly string[] | undefined;

/** A stored zone off the list still has to be an option, or saving replaces it. */
export const timeZoneOptions = (stored: string): readonly string[] =>
  timezoneChoices().includes(stored) ? timezoneChoices() : [...timezoneChoices(), stored].sort();

// Intl alone would also take `africa/harare`, `+02:00` and `CAT`.
const timeZoneSpelling = /^(UTC|GMT|(US|[A-Z][a-z]+)(\/[A-Z][A-Za-z0-9_+-]*)+)$/;

/**
 * The one test of a timezone, for creating a restaurant and for saving its
 * settings. Not the list above: that leaves out real names, like Asia/Kolkata,
 * and which ones depends on the runtime.
 */
export function isTimeZone(value: string) {
  if (!timeZoneSpelling.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const E164 = /^\+[1-9][0-9]{1,14}$/;

/**
 * What the owner typed as the E.164 number it means. Only a recognisable local
 * number gets the country code, or one typed with it but no +. Anything else
 * without a + could be another country's, so it is left for the pattern to refuse.
 */
function contactPhoneOf(typed: string) {
  const digits = typed
    .replace(/[\s.-]/g, "")
    // "+263 (0)77...": the 0 is only dialled without the country code.
    .replace(/^(\(?(?:(?:\+|00)[1-9][0-9]{0,2}|263)\)?)\(0\)/, "$1")
    .replace(/[()]/g, "")
    .replace(/^00/, "+");
  if (/^263[0-9]{9}$/.test(digits)) return `+${digits}`;
  const local = /^0[1-9][0-9]{7,8}$/.test(digits) || /^[1-9][0-9]{8}$/.test(digits);
  // Known to be local, so a number that begins like the code (0263…) still gets it.
  return local ? `${DEFAULT_COUNTRY_CODE}${digits.replace(/^0/, "")}` : digits;
}

export const invalidTimezoneMessage = "Choose a timezone from the list.";

const messages = {
  name: "Enter the restaurant's name, up to 200 characters.",
  contactPhone: "Enter a phone number, like 0771234567 or +263771234567.",
  wifiName: "Enter a Wi-Fi name of up to 200 characters.",
  wifiPassword: "Enter a Wi-Fi password of up to 200 characters.",
  wifiPasswordWithoutName:
    "Enter the Wi-Fi name that goes with this password, or clear the password.",
  currencyMode: "Choose a currency mode.",
  timezone: invalidTimezoneMessage,
};

const blankToNull = (value: string) => value || null;

// Messages are fixed strings, so a refused value is never echoed back.
const settingsForm = z
  .object({
    name: z.string(messages.name).trim().min(1, messages.name).max(200, messages.name),
    contactPhone: z
      .string(messages.contactPhone)
      .transform(contactPhoneOf)
      .refine((value) => value === "" || E164.test(value), messages.contactPhone)
      .transform(blankToNull),
    wifiName: z
      .string(messages.wifiName)
      .trim()
      .max(200, messages.wifiName)
      .transform(blankToNull),
    // Not trimmed: spaces can be part of a password.
    wifiPassword: z
      .string(messages.wifiPassword)
      .max(200, messages.wifiPassword)
      .transform(blankToNull),
    currencyMode: z.enum(currencyMode.enumValues, messages.currencyMode),
    // Only its shape here. Whether it is a real zone depends on what is stored, so
    // updateRestaurantSettings decides.
    timezone: z.string(messages.timezone).min(1, messages.timezone).max(100, messages.timezone),
  })
  // A password printed on the cards with no network to join is a mistake.
  .refine(({ wifiName, wifiPassword }) => wifiPassword === null || wifiName !== null, {
    message: messages.wifiPasswordWithoutName,
    path: ["wifiName"],
  });

export type RestaurantSettings = z.output<typeof settingsForm>;

export function parseRestaurantSettings(form: FormData) {
  const parsed = settingsForm.safeParse(Object.fromEntries(form));
  return parsed.success
    ? ({ success: true, data: parsed.data } as const)
    : ({
        success: false,
        message: parsed.error.issues[0].message,
        /** The form control the message belongs by. */
        field: String(parsed.error.issues[0].path[0] ?? ""),
      } as const);
}

export async function getRestaurantSettings(
  ctx: Tenant,
): Promise<RestaurantSettings> {
  const [settings] = await withTenant(ctx, (tx) =>
    tx
      .select({
        name: restaurants.name,
        contactPhone: restaurants.contactPhone,
        wifiName: restaurants.wifiName,
        wifiPassword: restaurants.wifiPassword,
        currencyMode: restaurants.currencyMode,
        timezone: restaurants.timezone,
      })
      .from(restaurants)
      .where(eq(restaurants.id, ctx.restaurantId)),
  );
  return settings;
}

/** Whether online booking is on, read before and after a save that may switch it off in Postgres. */
export async function onlineBookingOn(tx: TenantTransaction, restaurantId: string) {
  const [settings] = await tx
    .select({ enabled: bookingSettings.enabled })
    .from(bookingSettings)
    .where(eq(bookingSettings.restaurantId, restaurantId));
  return settings?.enabled === true;
}

/**
 * Saves the settings. A timezone that differs from the stored one has to work
 * in JavaScript and in Postgres, where `AT TIME ZONE` would otherwise fail on
 * it later, as restaurant creation already insists. One that is unchanged is
 * never refused, whatever it is: the form sends it back with every save, and a
 * name that has since fallen out of either list must not block other edits. A
 * currency mode that would show a special above its normal price is refused by
 * Postgres (S-45), and nothing is saved: `above` is which specials.
 */
export async function updateRestaurantSettings(
  ctx: Tenant & Pick<TenantContext, "platformAdminId">,
  settings: RestaurantSettings,
): Promise<"saved" | "saved_booking_off" | "invalid_timezone" | { above: SpecialAbove[] }> {
  const saving = withTenant(ctx, async (tx) => {
    // One read for both: the stored zone, and whether booking is on before a clear of the phone could switch it off.
    const [stored] = await tx
      .select({
        timezone: restaurants.timezone,
        bookingOn: sql<boolean>`coalesce((select b.enabled from booking_settings b where b.restaurant_id = restaurants.id), false)`,
      })
      .from(restaurants)
      .where(eq(restaurants.id, ctx.restaurantId));
    if (stored.timezone !== settings.timezone) {
      if (!isTimeZone(settings.timezone)) return "invalid_timezone" as const;
      const { rows } = await tx.execute(
        sql`select 1 from pg_catalog.pg_timezone_names where name = ${settings.timezone}`,
      );
      if (rows.length === 0) return "invalid_timezone" as const;
    }
    await tx
      .update(restaurants)
      .set(settings)
      .where(eq(restaurants.id, ctx.restaurantId));
    await recordAdminAction(tx, ctx, {
      action: "restaurant.update",
      entityType: "restaurant",
      entityId: ctx.restaurantId,
    });
    // Only clearing the contact phone switches online booking off in Postgres (a trigger), so
    // that is the only save that has to look again.
    const switchedOff =
      stored.bookingOn && settings.contactPhone === null && !(await onlineBookingOn(tx, ctx.restaurantId));
    return switchedOff ? ("saved_booking_off" as const) : ("saved" as const);
  });
  const outcome = await saving.catch((error: unknown) => {
    const above = specialsAbove(error);
    if (above) return { above };
    throw error;
  });
  // The public menu page shows the restaurant's name.
  if (outcome === "saved" || outcome === "saved_booking_off") revalidateMenu(ctx);
  return outcome;
}
