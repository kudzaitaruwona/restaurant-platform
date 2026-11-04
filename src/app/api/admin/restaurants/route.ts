import type { NextRequest } from "next/server";
import { z } from "zod";
import { currencyMode } from "@/db/schema";
import { isTimeZone } from "@/lib/restaurant-settings";
import {
  createRestaurant,
  DEFAULT_TIMEZONE,
  getPlatformAdminContext,
} from "@/lib/tenant/platform-admin";

const unknownTimezone = "Enter a timezone like Africa/Harare.";

const newRestaurant = z.object({
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

/** Creates a restaurant. It has no staff yet: its first owner comes next. */
export async function POST(request: NextRequest) {
  const admin = await getPlatformAdminContext();

  const input = newRestaurant.safeParse(
    Object.fromEntries(await request.formData()),
  );
  if (!input.success) {
    return Response.json(
      { error: input.error.issues[0].message },
      { status: 400 },
    );
  }

  const result = await createRestaurant(admin, input.data);
  if ("problem" in result) {
    return result.problem === "slug_taken"
      ? Response.json({ error: "That slug is already in use." }, { status: 409 })
      : Response.json({ error: unknownTimezone }, { status: 400 });
  }

  return Response.json({ id: result.id }, { status: 201 });
}
