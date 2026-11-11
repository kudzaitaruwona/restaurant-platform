import type { NextRequest } from "next/server";
import { importAnswer, readImportRequest } from "@/lib/import-request";
import { importMenu, previewMenuImport } from "@/lib/menu-import";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/** Previews or imports menu items from CSV, from /dashboard/menu. Owner only (S-26, S-43). */
export async function POST(request: NextRequest) {
  const tenant = await getTenantContext();
  requireOwner(tenant);

  const input = await readImportRequest(request);
  if (input instanceof Response) return input;

  return importAnswer(
    input.intent === "preview"
      ? await previewMenuImport(tenant, input.csv)
      : await importMenu(tenant, input.csv),
  );
}
