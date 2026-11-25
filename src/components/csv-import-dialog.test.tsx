import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CsvImportDialog, importLabel, ReportTable } from "./csv-import-dialog";

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

  it("says the kind's own row cap: 500 unless the kind takes fewer", () => {
    expect(dialog()).toContain("Up to 500 rows and 1 MB.");
    const staff = renderToStaticMarkup(
      <CsvImportDialog
        kind="staff"
        action="/api/staff/import"
        title="Import staff"
        noun={{ one: "person", other: "people" }}
        intro={<p>Columns: email, name and role.</p>}
        maxRows={50}
      />,
    );
    expect(staff).toContain("Up to 50 rows and 1 MB.");
    expect(staff).not.toContain("500");
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

describe("the report on a phone", () => {
  const html = renderToStaticMarkup(<ReportTable report={report} done={false} />);
  const cards = html.slice(0, html.indexOf("<table") > 0 ? html.indexOf('<div class="hidden') : 0);

  it("lists each row as a card shown below 768px, with the reason inside it", () => {
    expect(html).toMatch(/<ul[^>]*class="[^"]*md:hidden/);
    expect(html).toMatch(/<div class="hidden[^"]*md:block/);
    // The skipped row's reason is in the card, not only in the table's last column.
    expect(cards).toContain("Skipped");
    expect(cards).toContain("Enter how many people the table seats, from 1 to 100.");
    expect(cards).toContain("Line 3");
  });

  it("puts a row's outcome before its values, so it is read first", () => {
    expect(cards.indexOf("Ready")).toBeGreaterThan(-1);
    expect(cards.indexOf("Ready")).toBeLessThan(cards.indexOf("<dl"));
  });

  it("labels each value with its column", () => {
    expect(cards).toContain(">seats</dt>");
  });
});

describe("the Import button", () => {
  it("never offers to import zero rows", () => {
    expect(importLabel(0)).toBe("Nothing to import");
    expect(importLabel(1)).toBe("Import 1 row");
    expect(importLabel(3)).toBe("Import 3 rows");
  });
});

describe("the choose step", () => {
  it("is a form that stays in the markup, shown at first, so Back can find the input in it", () => {
    const html = dialog();
    const form = /<form[^>]*>/.exec(html)![0];
    expect(form).toContain("flex");
    expect(form).not.toMatch(/\bhidden\b/);
  });
});
