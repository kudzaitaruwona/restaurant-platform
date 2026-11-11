import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { diningTables } from "@/db/schema";
import { readCsvTable, yesNo } from "@/lib/csv";
import {
  type ImportReport,
  type ImportValues,
  importColumns,
  reportOf,
  reportRow,
} from "@/lib/csv-import";
import { mintQrToken } from "@/lib/qr-token";
import { isLabelTaken, type NewTable, parseNewTable } from "@/lib/tables";
import { recordAudit } from "@/lib/tenant/audit";
import { type TenantContext, type TenantTransaction, withTenant } from "@/lib/tenant/scope";

/**
 * Tables import from CSV (S-43, spec 03). Owner only, as tables are (S-26):
 * callers check requireOwner(ctx). Each row goes through the table form's own
 * parser, and gets its QR token and its place at the end of the list as adding
 * one by hand does (addTable in tables.ts, kept alike), all in one insert
 * rather than one per row (S-43). A label already on a live table is skipped, never overwritten.
 */

type Importer = Pick<TenantContext, "restaurantId" | "staffId" | "platformAdminId">;
type Row = ImportValues<"tables">;
type Planned = { row: Row; problems: string[]; table?: NewTable & { bookable: boolean } };

export const labelRaceMessage = "Another table took one of these labels just now. Check the file again.";

/** Labels compare as the database's unique index does: exactly. */
async function plan(tx: TenantTransaction, restaurantId: string, rows: Row[]) {
  const live = await tx
    .select({ label: diningTables.label })
    .from(diningTables)
    .where(and(eq(diningTables.restaurantId, restaurantId), isNull(diningTables.archivedAt)));
  const taken = new Set(live.map((table) => table.label));
  const inFile = new Map<string, number>();

  return rows.map((row): Planned => {
    const form = new FormData();
    form.set("label", row.values.label);
    form.set("capacity", row.values.seats);
    const table = parseNewTable(form);
    const bookable = yesNo(row.values.bookable, true);
    const problems: string[] = [];
    if (!table.success) problems.push(table.message);
    if (bookable === null) problems.push('Write yes or no in "bookable", or leave it blank for yes.');
    if (table.success) {
      const { label } = table.data;
      if (taken.has(label)) problems.push(`Table ${label} already exists.`);
      else if (inFile.has(label)) problems.push(`Table ${label} is already in this file, on line ${inFile.get(label)}.`);
      else if (!row.extraCells) inFile.set(label, row.line);
    }
    return problems.length === 0 && !row.extraCells && table.success
      ? { row, problems, table: { ...table.data, bookable: bookable! } }
      : { row, problems };
  });
}

const toReport = (planned: Planned[], imported: number | null): ImportReport =>
  reportOf(
    "tables",
    planned.map(({ row, problems }) => reportRow("tables", row, problems)),
    imported,
  );

const read = (csv: string) => readCsvTable(csv, importColumns.tables);

/** What importing would do, row by row. Writes nothing. */
export async function previewTablesImport(
  ctx: Pick<TenantContext, "restaurantId">,
  csv: string,
): Promise<ImportReport | { error: string }> {
  const table = read(csv);
  if (!table.ok) return { error: table.error };
  const planned = await withTenant(ctx, (tx) => plan(tx, ctx.restaurantId, table.rows));
  return toReport(planned, null);
}

/**
 * Adds every valid row in one transaction, in file order after the existing
 * tables, and audits that once with the counts. If another owner adds one of
 * the labels meanwhile, the database refuses it and nothing is added.
 */
export async function importTables(
  ctx: Importer,
  csv: string,
): Promise<ImportReport | { error: string }> {
  const table = read(csv);
  if (!table.ok) return { error: table.error };

  const { restaurantId } = ctx;
  try {
    const { planned, imported } = await withTenant(ctx, async (tx) => {
      const planned = await plan(tx, restaurantId, table.rows);
      const ready = planned.flatMap((entry) => (entry.table ? [entry.table] : []));
      if (ready.length === 0) return { planned, imported: 0 };
      // After the last table, archived ones included, as addTable places one.
      const [{ next }] = await tx
        .select({ next: sql<number>`coalesce(max(${diningTables.sortOrder}), -1) + 1` })
        .from(diningTables)
        .where(eq(diningTables.restaurantId, restaurantId));
      await tx
        .insert(diningTables)
        .values(ready.map((row, i) => ({ ...row, restaurantId, qrToken: mintQrToken(), sortOrder: next + i })));
      await recordAudit(tx, ctx, {
        action: "table.import",
        entityType: "restaurant",
        entityId: restaurantId,
        details: { tables: ready.length, skipped: planned.length - ready.length },
      });
      return { planned, imported: ready.length };
    });
    return toReport(planned, imported);
  } catch (error) {
    if (isLabelTaken(error)) return { error: labelRaceMessage };
    throw error;
  }
}
