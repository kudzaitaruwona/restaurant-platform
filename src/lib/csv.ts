/**
 * The one CSV reader for every import (S-43): RFC 4180 (quoted values, "" for
 * a quote inside one, commas and newlines inside quotes, CRLF or LF), plus what
 * spreadsheets actually save: a UTF-8 byte order mark, and a semicolon instead
 * of a comma where the locale uses a decimal comma. No dependency: the format
 * is small, and the rules below (limits, header matching) are ours anyway.
 *
 * Values are only ever text here. Nothing is evaluated, so a cell starting with
 * "=" is stored as those characters. Nothing re-exports what was imported, so
 * nothing is neutralised either (S-43).
 *
 * No server-only import: the import dialog checks the size in the browser too.
 */

/** 1 MB: the most one import reads. */
export const CSV_MAX_BYTES = 1024 * 1024;
/** The most rows one import takes, not counting the header. */
export const CSV_MAX_ROWS = 500;

export type CsvRecord = { /** The line the record starts on, from 1. */ line: number; cells: string[] };

type Parsed = { ok: true; records: CsvRecord[] } | { ok: false; error: string };

const BOM = "﻿";

export const byteLength = (text: string) => new TextEncoder().encode(text).length;

/** Semicolon when the header row has more of them than commas, outside quotes. */
function delimiterOf(text: string) {
  let commas = 0;
  let semicolons = 0;
  let quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === "\n" || char === "\r")) break;
    else if (!quoted && char === ",") commas++;
    else if (!quoted && char === ";") semicolons++;
  }
  return semicolons > commas ? ";" : ",";
}

export function parseCsv(input: string): Parsed {
  if (byteLength(input) > CSV_MAX_BYTES) {
    return { ok: false, error: "The file is over 1 MB. Split it and import each part." };
  }
  const text = input.startsWith(BOM) ? input.slice(1) : input;
  const delimiter = delimiterOf(text);

  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = "";
  let line = 1;
  let recordLine = 1;
  // Whether anything has been read for the current record, so a blank line is skipped.
  let started = false;
  let i = 0;

  const endRecord = () => {
    cells.push(cell);
    if (started) records.push({ line: recordLine, cells });
    cells = [];
    cell = "";
    started = false;
  };

  while (i < text.length) {
    const char = text[i];
    if (!started) recordLine = line;

    if (char === '"' && cell === "") {
      // A quoted value: up to the quote that isn't doubled.
      const opened = line;
      started = true;
      i++;
      let closed = false;
      while (i < text.length) {
        const inner = text[i];
        if (inner === '"') {
          if (text[i + 1] === '"') {
            cell += '"';
            i += 2;
            continue;
          }
          closed = true;
          i++;
          break;
        }
        if (inner === "\n") line++;
        // A lone CR inside quotes counts as a line too, but not the CR of a CRLF.
        if (inner === "\r" && text[i + 1] !== "\n") line++;
        cell += inner;
        i++;
      }
      if (!closed) {
        return { ok: false, error: `A quoted value starting on line ${opened} is never closed.` };
      }
      const next = text[i];
      if (next !== undefined && next !== delimiter && next !== "\n" && next !== "\r") {
        return {
          ok: false,
          error: `Line ${line} has text straight after a closing quote. Put quotes around the whole value.`,
        };
      }
      continue;
    }

    if (char === delimiter) {
      started = true;
      cells.push(cell);
      cell = "";
      i++;
      continue;
    }
    if (char === "\r" || char === "\n") {
      endRecord();
      i += char === "\r" && text[i + 1] === "\n" ? 2 : 1;
      line++;
      continue;
    }
    started = true;
    cell += char;
    i++;
  }
  if (started || cell !== "" || cells.length > 0) endRecord();

  if (records.length === 0) return { ok: false, error: "The file is empty." };
  return { ok: true, records };
}

export type CsvColumn<Key extends string = string> = {
  key: Key;
  /** The name in the header row, matched without regard to case. */
  header: string;
  required?: boolean;
};

export type CsvRow<Key extends string> = {
  line: number;
  values: Record<Key, string>;
  /** How many cells the row has past the last column, when it has any. */
  extraCells?: number;
};

export type CsvTable<Key extends string> =
  | { ok: true; rows: CsvRow<Key>[] }
  | { ok: false; error: string };

/**
 * Reads a CSV whose first row names its columns. Every column must be one of
 * `columns` (a typo would otherwise drop a whole column without a word), every
 * required one must be there, and values are trimmed. A missing optional column
 * reads as blank.
 */
export function readCsvTable<const Columns extends readonly CsvColumn[]>(
  text: string,
  columns: Columns,
): CsvTable<Columns[number]["key"]> {
  type Key = Columns[number]["key"];
  const parsed = parseCsv(text);
  if (!parsed.ok) return parsed;
  const [header, ...body] = parsed.records;

  const names = header.cells.map((name) => name.trim().toLowerCase());
  const known = new Map(columns.map((column) => [column.header.toLowerCase(), column]));
  const unknown = names.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    return {
      ok: false,
      error:
        `The header row has ${unknown.length === 1 ? "a column" : "columns"} this import doesn't use: ` +
        `${unknown.map((name) => `"${name}"`).join(", ")}. ` +
        `The columns are ${columns.map((column) => column.header).join(", ")}.`,
    };
  }
  const repeated = names.find((name, index) => names.indexOf(name) !== index);
  if (repeated) return { ok: false, error: `The header row names "${repeated}" twice.` };
  const missing = columns.find((column) => column.required && !names.includes(column.header.toLowerCase()));
  if (missing) return { ok: false, error: `The header row has no "${missing.header}" column.` };

  if (body.length === 0) {
    return { ok: false, error: "The file has a header row but no rows under it." };
  }
  if (body.length > CSV_MAX_ROWS) {
    return {
      ok: false,
      error: `The file has ${body.length} rows. Import at most ${CSV_MAX_ROWS} at a time.`,
    };
  }

  const position = new Map(names.map((name, index) => [known.get(name)!.key as Key, index]));
  const rows = body.map(({ line, cells }) => {
    const values = Object.fromEntries(
      columns.map((column) => {
        const index = position.get(column.key as Key);
        return [column.key, index === undefined ? "" : (cells[index] ?? "").trim()];
      }),
    ) as Record<Key, string>;
    const extra = cells.length - names.length;
    return extra > 0 ? { line, values, extraCells: extra } : { line, values };
  });
  return { ok: true, rows };
}

/** yes/no, y/n, true/false or 1/0, any case. Blank is `fallback`, anything else null. */
export function yesNo(value: string, fallback: boolean): boolean | null {
  const word = value.trim().toLowerCase();
  if (word === "") return fallback;
  if (["yes", "y", "true", "1"].includes(word)) return true;
  if (["no", "n", "false", "0"].includes(word)) return false;
  return null;
}

const quoted = (value: string) =>
  /[",\r\n;]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

/** A small CSV for a template download: header, rows, CRLF as RFC 4180 has it. */
export function templateCsv(header: readonly string[], rows: readonly (readonly string[])[]) {
  return [header, ...rows].map((row) => row.map(quoted).join(",") + "\r\n").join("");
}
