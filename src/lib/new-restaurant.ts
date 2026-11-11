import "server-only";
import { z } from "zod";
import { currencyMode } from "@/db/schema";
import { isTimeZone } from "@/lib/restaurant-settings";
import { DEFAULT_TIMEZONE } from "@/lib/tenant/platform-admin";

/**
 * The rules for a new restaurant and its first owner (spec 01), shared by
 * /admin's single forms and the restaurants import (S-42, S-43), so the two
 * can't take different input.
 */

export const unknownTimezone = "Enter a timezone like Africa/Harare.";

export const newRestaurant = z.object({
  name: z.string("Enter a name.").trim().min(1, "Enter a name.").max(200, "That name is too long."),
  // A public URL segment: /r/{slug}.
  slug: z
    .string("Enter a slug.")
    .trim()
    .toLowerCase()
    .max(63, "That slug is too long.")
    .regex(
      /^[a-z0-9]+(-[a-z0-9]+)*$/,
      "A slug is lowercase letters and numbers, separated by single hyphens.",
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
