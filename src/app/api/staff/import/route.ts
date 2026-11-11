import type { NextRequest } from "next/server";
import { importAnswer, readImportRequest } from "@/lib/import-request";
import { importStaff, previewStaffImport } from "@/lib/staff-import";
import { getTenantContext, requireOwner } from "@/lib/tenant";

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
