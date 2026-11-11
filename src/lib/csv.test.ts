import { describe, expect, it } from "vitest";
import {
  CSV_MAX_BYTES,
  CSV_MAX_ROWS,
  parseCsv,
  readCsvTable,
  templateCsv,
  yesNo,
} from "./csv";

const records = (text: string) => {
  const result = parseCsv(text);
  if (!result.ok) throw new Error(result.error);
  return result.records.map((record) => record.cells);
};

describe("parseCsv (RFC 4180)", () => {
  it("splits plain records on commas and newlines", () => {
    expect(records("a,b,c\n1,2,3\n")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("takes CRLF and a last line with no newline", () => {
    expect(records("a,b\r\n1,2\r\n3,4")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("keeps commas, escaped quotes and newlines inside quotes", () => {
    expect(records('name,description\n"Burger, large","The ""big"" one\nwith chips"\n')).toEqual([
      ["name", "description"],
      ["Burger, large", 'The "big" one\nwith chips'],
    ]);
  });

  it("keeps empty cells, including a trailing one", () => {
    expect(records("a,b,c\n1,,\n")).toEqual([
      ["a", "b", "c"],
      ["1", "", ""],
    ]);
  });

  it("skips blank lines", () => {
    expect(records("a\n\n1\r\n\r\n2\n")).toEqual([["a"], ["1"], ["2"]]);
  });

  it("strips a UTF-8 byte order mark", () => {
    expect(records("﻿category,name\nMains,Burger")[0]).toEqual(["category", "name"]);
  });

  it("detects a semicolon delimiter from the header row", () => {
    expect(records("label;seats\nT1;4\n\"A;B\";2")).toEqual([
      ["label", "seats"],
      ["T1", "4"],
      ["A;B", "2"],
    ]);
  });

  it("keeps commas in cells of a semicolon file", () => {
    expect(records("name;price_usd\nBurger;8,50")).toEqual([
      ["name", "price_usd"],
      ["Burger", "8,50"],
    ]);
  });

  it("numbers each record by the line it starts on", () => {
    const result = parseCsv('a,b\n"x\ny",1\n\n2,3');
    expect(result.ok && result.records.map((record) => record.line)).toEqual([1, 2, 5]);
  });

  it("refuses a quote that is never closed", () => {
    expect(parseCsv('a,b\n"open,1')).toEqual({
      ok: false,
      error: "A quoted value starting on line 2 is never closed.",
    });
  });

  it("refuses text after a closing quote", () => {
    expect(parseCsv('a,b\n"x"y,1').ok).toBe(false);
  });

  it("refuses a file over 1 MB", () => {
    const big = "a\n" + "x".repeat(CSV_MAX_BYTES);
    expect(parseCsv(big)).toEqual({ ok: false, error: "The file is over 1 MB. Split it and import each part." });
  });

  it("counts bytes, not characters, for the limit", () => {
    // Each "é" is two bytes in UTF-8.
    const text = "a\n" + "é".repeat(CSV_MAX_BYTES / 2 + 1);
    expect(parseCsv(text).ok).toBe(false);
  });

  it("refuses an empty file", () => {
    expect(parseCsv("\n\n").ok).toBe(false);
  });
});

describe("readCsvTable", () => {
  const columns = [
    { key: "label", header: "label", required: true },
    { key: "seats", header: "seats", required: true },
    { key: "bookable", header: "bookable" },
  ] as const;

  it("reads rows by header name, whatever the case and order", () => {
    const table = readCsvTable(" Seats ,LABEL\n4,T1\n", columns);
    expect(table).toEqual({
      ok: true,
      rows: [{ line: 2, values: { label: "T1", seats: "4", bookable: "" } }],
    });
  });

  it("trims every value", () => {
    const table = readCsvTable("label,seats\n  T1 , 4 ", columns);
    expect(table.ok && table.rows[0].values).toEqual({ label: "T1", seats: "4", bookable: "" });
  });

  it("names a required column that is missing", () => {
    expect(readCsvTable("label\nT1", columns)).toEqual({
      ok: false,
      error: 'The header row has no "seats" column.',
    });
  });

  it("names a column it doesn't know, so a typo isn't silently dropped", () => {
    expect(readCsvTable("label,seats,colour\nT1,4,red", columns)).toEqual({
      ok: false,
      error: 'The header row has a column this import doesn\'t use: "colour". The columns are label, seats, bookable.',
    });
  });

  it("refuses a column named twice", () => {
    expect(readCsvTable("label,seats,Label\nT1,4,T2", columns).ok).toBe(false);
  });

  it("refuses a header row with nothing under it", () => {
    expect(readCsvTable("label,seats\n", columns)).toEqual({
      ok: false,
      error: "The file has a header row but no rows under it.",
    });
  });

  it("refuses more than 500 rows", () => {
    const text = "label,seats\n" + Array.from({ length: CSV_MAX_ROWS + 1 }, (_, i) => `T${i},2`).join("\n");
    expect(readCsvTable(text, columns)).toEqual({
      ok: false,
      error: "The file has 501 rows. Import at most 500 at a time.",
    });
  });

  it("takes exactly 500 rows", () => {
    const text = "label,seats\n" + Array.from({ length: CSV_MAX_ROWS }, (_, i) => `T${i},2`).join("\n");
    expect(readCsvTable(text, columns).ok).toBe(true);
  });

  it("treats a row with more cells than columns as a problem of that row", () => {
    const table = readCsvTable("label,seats\nT1,4,extra\nT2,2", columns);
    expect(table.ok && table.rows.map((row) => row.extraCells ?? 0)).toEqual([1, 0]);
  });

  it("passes a parse error through", () => {
    expect(readCsvTable('label,seats\n"T1,4', columns).ok).toBe(false);
  });
});

describe("yesNo", () => {
  it.each([
    ["", true],
    ["yes", true],
    ["Y", true],
    ["TRUE", true],
    ["1", true],
    ["no", false],
    ["n", false],
    ["False", false],
    ["0", false],
  ])("reads %j", (value, expected) => {
    expect(yesNo(value, true)).toBe(expected);
  });

  it("gives the default for a blank cell", () => {
    expect(yesNo("", false)).toBe(false);
  });

  it("is null for anything else", () => {
    expect(yesNo("maybe", true)).toBeNull();
  });
});

describe("templateCsv", () => {
  it("writes a header and example rows, quoting only what needs it, with CRLF", () => {
    expect(
      templateCsv(
        ["name", "description"],
        [["Burger, large", 'The "big" one']],
      ),
    ).toBe('name,description\r\n"Burger, large","The ""big"" one"\r\n');
  });
});
