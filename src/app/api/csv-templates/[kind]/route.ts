import { importTemplate, isImportKind } from "@/lib/csv-import";

/**
 * The template for an import (S-43): a header row and made-up example rows.
 * The same fixed text for everyone, with no tenant data, so it needs no session.
 */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/csv-templates/[kind]">,
) {
  const { kind } = await context.params;
  if (!isImportKind(kind)) return new Response("Not found", { status: 404 });

  const { filename, body } = importTemplate(kind);
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
