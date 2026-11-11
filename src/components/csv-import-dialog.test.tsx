import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CsvImportDialog, ReportTable } from "./csv-import-dialog";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));

/** No DOM here, as for the other client components: the markup is checked as rendered. */
const dialog = () =>
  renderToStaticMarkup(
    <CsvImportDialog
      kind="tables"
      action="/api/tables/import"
      title="Import tables"
      noun={{ one: "table", other: "tables" }}
      intro={<p>Columns: label, seats and bookable.</p>}
    />,
  );

const report = {
  columns: ["label", "seats", "bookable"],
  rows: [
    { line: 2, values: ["1", "4", "yes"], problems: [], notes: [] },
    { line: 3, values: ["2", "0", ""], problems: ["Enter how many people the table seats, from 1 to 100."], notes: [] },
  ],
  ready: 1,
  imported: null,
};

describe("the CSV import dialog", () => {
  it("opens from a button, as a closed <dialog> named by its title", () => {
    const html = dialog();
    expect(html).toContain("Import CSV");
    expect(html).toMatch(/<dialog[^>]*aria-labelledby="([^"]+)"/);
    expect(html).not.toMatch(/<dialog[^>]* open/);
    const id = /<dialog[^>]*aria-labelledby="([^"]+)"/.exec(html)![1];
    expect(html).toMatch(new RegExp(`<h2 id="${id}"[^>]*>Import tables</h2>`));
  });

  it("offers the kind's template, a file and a paste box, and says nothing is saved yet", () => {
    const html = dialog();
    expect(html).toContain('href="/api/csv-templates/tables"');
    expect(html).toMatch(/<input[^>]*type="file"[^>]*accept=".csv,text\/csv"/);
    expect(html).toContain('name="pasted"');
    expect(html).toContain("Nothing is saved until");
  });

  it("uses no em or en dash in what it says", () => {
    expect(dialog()).not.toMatch(/[–—]/);
  });
});

describe("the report table", () => {
  it("shows each row's line, values and whether it is ready or why it is skipped", () => {
    const html = renderToStaticMarkup(<ReportTable report={report} done={false} />);
    expect(html).toContain(">label</th>");
    expect(html).toContain("Ready");
    expect(html).toContain("Skipped");
    expect(html).toContain("Enter how many people the table seats, from 1 to 100.");
  });

  it("says Imported once done", () => {
    const html = renderToStaticMarkup(<ReportTable report={{ ...report, imported: 1 }} done />);
    expect(html).toContain("Imported");
    expect(html).toContain(">Result</th>");
  });
});
