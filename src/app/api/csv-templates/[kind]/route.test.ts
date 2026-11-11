import { describe, expect, it } from "vitest";
import { importColumns } from "@/lib/csv-import";
import { readCsvTable } from "@/lib/csv";
import { GET } from "./route";

const get = (kind: string) =>
  GET(new Request(`http://localhost/api/csv-templates/${kind}`), {
    params: Promise.resolve({ kind }),
  });

describe("GET /api/csv-templates/[kind]", () => {
  it.each(Object.keys(importColumns) as (keyof typeof importColumns)[])(
    "%s: a CSV download whose header is the import's columns, and which the import reads",
    async (kind) => {
      const response = await get(kind);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
      expect(response.headers.get("content-disposition")).toBe(
        `attachment; filename="${kind}-import-template.csv"`,
      );
      const text = await response.text();
      expect(text.split("\r\n")[0]).toBe(importColumns[kind].map((column) => column.header).join(","));
      expect(readCsvTable(text, importColumns[kind]).ok).toBe(true);
    },
  );

  it("no cell starts with a character a spreadsheet would run as a formula", async () => {
    for (const kind of Object.keys(importColumns)) {
      const text = await (await get(kind)).text();
      expect(text).not.toMatch(/(^|[,\r\n])[=+\-@]/);
    }
  });

  it("is a 404 for any other kind", async () => {
    expect((await get("bookings")).status).toBe(404);
    expect((await get("constructor")).status).toBe(404);
  });
});
