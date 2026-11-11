import type { NextRequest } from "next/server";
import { importAnswer, readImportRequest } from "@/lib/import-request";
import { importRestaurants, previewRestaurantsImport } from "@/lib/restaurant-import";
import { getPlatformAdminContext } from "@/lib/tenant/platform-admin";

/**
 * Rows go one at a time with an invite email each, so this can run for minutes:
 * the import stops starting rows before this (IMPORT_TIME_BUDGET_MS) and
 * reports the rest, so the answer always comes back (S-43).
 */
export const maxDuration = 300;

/**
 * Previews or creates restaurants with their first owners from CSV, from
 * /admin (S-42, S-43). Platform admin only: each row goes through the same
 * platform_* functions as the single forms (S-28). No restaurant id comes from
 * the request.
 */
export async function POST(request: NextRequest) {
  const admin = await getPlatformAdminContext();

  const input = await readImportRequest(request);
  if (input instanceof Response) return input;

  return importAnswer(
    input.intent === "preview"
      ? await previewRestaurantsImport(admin, input.csv)
      : await importRestaurants(admin, input.csv),
  );
}
