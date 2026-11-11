import { type CsvColumn, type CsvRow, templateCsv } from "./csv";

/**
 * What every CSV import shares (S-43): its columns, its template, and the
 * report its preview and its confirm both answer with. No server-only import:
 * the import dialog renders the report.
 */

export type ImportKind = "menu" | "tables" | "staff" | "restaurants";

export type ImportRow = {
  line: number;
  /** The row's values in the order of `columns`, as the file had them. */
  values: string[];
  /** Why the row is skipped. Empty means it is (or was) imported. */
  problems: string[];
  /** Worth knowing, and imported anyway. */
  notes: string[];
};

export type ImportReport = {
  columns: string[];
  rows: ImportRow[];
  /** Rows with no problems: what "Import" would add. */
  ready: number;
  /** Set once confirmed: how many rows were added. */
  imported: number | null;
};

export const importColumns = {
  menu: [
    { key: "category", header: "category", required: true },
    { key: "name", header: "name", required: true },
    { key: "description", header: "description" },
    { key: "priceUsd", header: "price_usd" },
    { key: "priceZig", header: "price_zig" },
    { key: "available", header: "available" },
  ],
  tables: [
    { key: "label", header: "label", required: true },
    { key: "seats", header: "seats", required: true },
    { key: "bookable", header: "bookable" },
  ],
  staff: [
    { key: "email", header: "email", required: true },
    { key: "name", header: "name", required: true },
    { key: "role", header: "role" },
  ],
  restaurants: [
    { key: "name", header: "restaurant_name", required: true },
    { key: "slug", header: "slug" },
    { key: "timezone", header: "timezone" },
    { key: "currencyMode", header: "currency_mode" },
    { key: "ownerEmail", header: "owner_email", required: true },
    { key: "ownerName", header: "owner_name", required: true },
  ],
} as const satisfies Record<ImportKind, readonly CsvColumn[]>;

export type ImportValues<Kind extends ImportKind> = CsvRow<
  (typeof importColumns)[Kind][number]["key"]
>;

const exampleRows: Record<ImportKind, string[][]> = {
  menu: [
    ["Mains", "Sadza and beef stew", "With greens", "8.50", "", "yes"],
    ["Mains", "Grilled bream", "", "12", "320", "yes"],
    ["Drinks", "Mazoe orange", "", "1.50", "", "no"],
  ],
  tables: [
    ["1", "4", "yes"],
    ["2", "2", "yes"],
    ["Bar 1", "2", "no"],
  ],
  staff: [
    ["tendai@example.com", "Tendai Moyo", "staff"],
    ["rudo@example.com", "Rudo Ncube", "owner"],
  ],
  restaurants: [
    ["Mama's Kitchen", "mamas-kitchen", "Africa/Harare", "usd_primary", "owner@example.com", "Chipo Dube"],
  ],
};

/** A template per kind: the header row and a few made-up rows to copy. */
export function importTemplate(kind: ImportKind) {
  return {
    filename: `${kind}-import-template.csv`,
    body: templateCsv(
      importColumns[kind].map((column) => column.header),
      exampleRows[kind],
    ),
  };
}

export const isImportKind = (value: string): value is ImportKind => Object.hasOwn(importColumns, value);

export const extraCellsProblem = "This row has more values than the header has columns.";

/** A row's report entry: its values in column order. */
export function reportRow<Kind extends ImportKind>(
  kind: Kind,
  row: ImportValues<Kind>,
  problems: string[] = [],
  notes: string[] = [],
): ImportRow {
  const values = row.values as Record<string, string>;
  return {
    line: row.line,
    values: importColumns[kind].map((column) => values[column.key]),
    problems: row.extraCells ? [extraCellsProblem, ...problems] : problems,
    notes,
  };
}

export function reportOf(
  kind: ImportKind,
  rows: ImportRow[],
  imported: number | null = null,
): ImportReport {
  return {
    columns: importColumns[kind].map((column) => column.header),
    rows,
    ready: rows.filter((row) => row.problems.length === 0).length,
    imported,
  };
}

export const unique = (messages: string[]) => [...new Set(messages)];
