import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CsvImportDialog, ImportBody, importLabel, ReportCards, ReportRows, ReportTable } from "./csv-import-dialog";

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

describe("the report table's line numbers", () => {
  it("never break: neither the word nor a number is split to make room for the values (#94)", () => {
    const html = renderToStaticMarkup(<ReportTable report={report} done={false} />);
    expect(html).toMatch(/<th[^>]*class="[^"]*whitespace-nowrap[^"]*"[^>]*>Line<\/th>/);
    expect(html).toMatch(/<td[^>]*class="[^"]*whitespace-nowrap[^"]*"[^>]*>3<\/td>/);
  });
});

describe("the report on a phone", () => {
  const cards = renderToStaticMarkup(<ReportCards report={report} done={false} />);

  it("lists each row as a card, with the reason inside it", () => {
    expect(cards).toContain("Skipped");
    expect(cards).toContain("Enter how many people the table seats, from 1 to 100.");
    expect(cards).toContain("Line 3");
    expect(cards).not.toContain("<table");
  });

  it("puts a row's outcome before its values, so it is read first", () => {
    expect(cards.indexOf("Ready")).toBeGreaterThan(-1);
    expect(cards.indexOf("Ready")).toBeLessThan(cards.indexOf("<dl"));
  });

  it("labels each value with its column", () => {
    expect(cards).toContain(">seats</dt>");
  });
});

describe("the report's rows", () => {
  it("are drawn once, as cards or as a table, never both", () => {
    const html = renderToStaticMarkup(<ReportRows report={report} done={false} />);
    expect(html.split("Enter how many people the table seats, from 1 to 100.")).toHaveLength(2);
  });
});

describe("the Import button", () => {
  it("never offers to import zero rows", () => {
    expect(importLabel(0)).toBe("Nothing to import");
    expect(importLabel(1)).toBe("Import 1 row");
    expect(importLabel(3)).toBe("Import 3 rows");
  });
});

describe("the dialog's body", () => {
  const body = (step: "choose" | "preview" | "done") =>
    renderToStaticMarkup(
      <ImportBody
        step={step}
        report={step === "choose" ? undefined : report}
        kind="tables"
        noun={{ one: "table", other: "tables" }}
        intro={<p>Columns: label, seats and bookable.</p>}
        formId="import-form"
        onCheck={() => {}}
        onFileChange={() => {}}
      />,
    );
  const formClass = (html: string) => /<form[^>]* class="([^"]*)"/.exec(html)?.[1].split(" ");

  it("shows the form at first, and no rows", () => {
    expect(formClass(body("choose"))).toContain("flex");
    expect(formClass(body("choose"))).not.toContain("hidden");
    expect(body("choose")).not.toContain("Skipped");
  });

  it.each(["preview", "done"] as const)(
    "hides the form at %s but keeps it and its inputs mounted, so Back finds what was typed (#114)",
    (step) => {
      const html = body(step);
      expect(formClass(html)).toContain("hidden");
      expect(formClass(html)).not.toContain("flex");
      expect(html).toMatch(/<input[^>]*type="file"[^>]*name="file"/);
      expect(html).toContain('name="pasted"');
      expect(html).toContain("Skipped");
    },
  );
});
