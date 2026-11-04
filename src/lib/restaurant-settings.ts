import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { currencyMode, restaurants } from "@/db/schema";
import { type TenantContext, withTenant } from "@/lib/tenant";

/**
 * Restaurant settings, owner only (S-26): callers check requireOwner(ctx).
 * Holds the Wi-Fi password, so nothing here logs or audits the values. Settings
 * edits aren't on spec 01's audit list.
 */

type Tenant = Pick<TenantContext, "restaurantId">;

/** Exact names only: Intl alone would also take `africa/harare` and `+02:00`. */
export const timeZoneNames = [
  ...new Set([...Intl.supportedValuesOf("timeZone"), "UTC"]),
].sort();

const timeZones = new Set(timeZoneNames);

const E164 = /^\+[1-9][0-9]{1,14}$/;

const messages = {
  name: "Enter the restaurant's name, up to 200 characters.",
  contactPhone: "Enter the phone number in international format, like +263771234567.",
  wifiName: "Enter a Wi-Fi name of up to 200 characters.",
  wifiPassword: "Enter a Wi-Fi password of up to 200 characters.",
  currencyMode: "Choose a currency mode.",
  timezone: "Choose a timezone from the list.",
};

const blankToNull = (value: string) => value || null;

// Messages are fixed strings, so a refused value is never echoed back.
const settingsForm = z.object({
  name: z.string(messages.name).trim().min(1, messages.name).max(200, messages.name),
  contactPhone: z
    .string(messages.contactPhone)
    .transform((value) => value.replace(/[\s-]/g, ""))
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
  timezone: z
    .string(messages.timezone)
    .refine((value) => timeZones.has(value), messages.timezone),
});

export type RestaurantSettings = z.output<typeof settingsForm>;

export function parseRestaurantSettings(form: FormData) {
  const parsed = settingsForm.safeParse(Object.fromEntries(form));
  return parsed.success
    ? ({ success: true, data: parsed.data } as const)
    : ({ success: false, message: parsed.error.issues[0].message } as const);
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

export async function updateRestaurantSettings(
  ctx: Tenant,
  settings: RestaurantSettings,
) {
  await withTenant(ctx, (tx) =>
    tx
      .update(restaurants)
      .set(settings)
      .where(eq(restaurants.id, ctx.restaurantId)),
  );
}
