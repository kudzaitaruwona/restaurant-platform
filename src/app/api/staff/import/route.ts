import type { NextRequest } from "next/server";
import { importAnswer, readImportRequest } from "@/lib/import-request";
import { importStaff, previewStaffImport } from "@/lib/staff-import";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/**
 * Rows go one at a time with an invite email each, so this can run for minutes:
 * the import stops starting rows before this (IMPORT_TIME_BUDGET_MS) and
 * reports the rest, so the answer always comes back (S-43).
 */
export const maxDuration = 300;

/**
 * Previews or imports staff from CSV, from /dashboard/staff. Owner only (S-26).
 * Each person goes through addStaff, so is invited as when added by hand (S-42).
 */
export async function POST(request: NextRequest) {
  const tenant = await getTenantContext();
  requireOwner(tenant);

  const input = await readImportRequest(request);
  if (input instanceof Response) return input;

  return importAnswer(
    input.intent === "preview"
      ? await previewStaffImport(tenant, input.csv)
      : await importStaff(tenant, input.csv),
  );
}
