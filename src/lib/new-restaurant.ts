import "server-only";
import { z } from "zod";
import { currencyMode } from "@/db/schema";
import { isTimeZone } from "@/lib/restaurant-settings";
import { type CurrencyMode, DEFAULT_TIMEZONE } from "@/lib/tenant/platform-admin";

/**
 * The rules for a new restaurant and its first owner (spec 01), shared by
 * /admin's single forms and the restaurants import (S-42, S-43), so the two
 * can't take different input.
 */

/** A new restaurant with no currency chosen: USD with ZiG beneath it, spec 02's example. */
export const DEFAULT_CURRENCY_MODE: CurrencyMode = "usd_primary";

/**
 * The timezones the New restaurant sheet offers, as a list instead of free
 * text: every one the runtime knows, with the default among them.
 */
export const timezoneChoices = (): readonly string[] =>
  (choices ??= [
    ...new Set([DEFAULT_TIMEZONE, ...Intl.supportedValuesOf("timeZone").filter(isTimeZone)]),
  ].sort());

/** Checking each zone builds a DateTimeFormat, hundreds in all, so once. */
let choices: readonly string[] | undefined;

export const unknownTimezone = "Enter a timezone like Africa/Harare.";

export const newRestaurant = z.object({
  name: z.string("Enter a name.").trim().min(1, "Enter a name.").max(200, "That name is too long."),
  // A public URL segment, /r/{slug}, called the public address on screen.
  slug: z
    .string("Enter a public address.")
    .trim()
    .toLowerCase()
    .max(63, "That public address is too long.")
    .regex(
      /^[a-z0-9]+(-[a-z0-9]+)*$/,
      "A public address is lowercase letters and numbers, separated by single hyphens.",
    ),
  timezone: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string()
      .trim()
      .default(DEFAULT_TIMEZONE)
      .refine(isTimeZone, unknownTimezone),
  ),
  currencyMode: z.enum(currencyMode.enumValues, "Choose a currency mode."),
});

/** The wording for a public address already taken, for the form and the import alike. */
export const addressTaken = (slug?: string) =>
  slug ? `The public address ${slug} is already in use.` : "That public address is already in use.";

export const newOwner = z.object({
  // Lowercased because sign-in matches on it and the unique index is exact.
  email: z
    .string("Enter an email address.")
    .trim()
    .toLowerCase()
    .pipe(z.email("Enter an email address.")),
  displayName: z
    .string("Enter a name.")
    .trim()
    .min(1, "Enter a name.")
    .max(200, "That name is too long."),
});
