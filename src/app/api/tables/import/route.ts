import type { NextRequest } from "next/server";
import { importAnswer, readImportRequest } from "@/lib/import-request";
import { importTables, labelRaceMessage, previewTablesImport } from "@/lib/tables-import";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/** Previews or imports tables from CSV, from /dashboard/tables. Owner only (S-26, S-43). */
export async function POST(request: NextRequest) {
  const tenant = await getTenantContext();
  requireOwner(tenant);

  const input = await readImportRequest(request);
  if (input instanceof Response) return input;

  if (input.intent === "preview") return importAnswer(await previewTablesImport(tenant, input.csv));
  const result = await importTables(tenant, input.csv);
  // Another owner added one of the labels meanwhile, so nothing was added.
  return importAnswer(result, "error" in result && result.error === labelRaceMessage ? 409 : 400);
}
