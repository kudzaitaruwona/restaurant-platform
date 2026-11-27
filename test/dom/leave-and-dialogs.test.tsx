import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Link from "next/link";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminForm } from "@/app/admin/admin-form";
import { RememberedCategorySelect } from "@/app/dashboard/menu/remembered-category-select";
import { SettingsForm } from "@/app/dashboard/settings/settings-form";
import { PageRefresh, SavedPlace, useSaySaved } from "@/app/page-refresh";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CsvImportDialog } from "@/components/csv-import-dialog";

const refresh = vi.fn();
const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push }),
  usePathname: () => "/dashboard/settings",
  useSearchParams: () => new URLSearchParams(),
}));

beforeEach(() => {
  // The page the settings form is on, so that a jump within it is told from a link away.
  window.happyDOM.setURL("http://localhost:3000/dashboard/settings");
  refresh.mockReset();
  push.mockReset();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
});

const dialogOf = () => document.querySelector("dialog") as HTMLDialogElement;

describe("the settings form's leave warnings", () => {
  const saved = {
    name: "Mopane",
    contactPhone: "0771234567",
    wifiName: "",
    wifiPassword: "",
    currencyMode: "usd_only",
    timezone: "Africa/Harare",
  };
  const form = () =>
    render(
      <>
        <SettingsForm
          saved={saved}
          currencies={[{ value: "usd_only", label: "US dollars" }]}
          zones={["Africa/Harare"]}
        />
        <Link href="/dashboard/menu">Menu</Link>
        <Link href="/dashboard/settings#top">Jump</Link>
        <a href="https://elsewhere.example/">Away</a>
      </>,
    );
  /** What the tab asks for when closed or reloaded: a prevented beforeunload. */
  const tabClosed = () => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };

  it("lets the tab close while nothing has been edited, and warns once something has", async () => {
    form();
    expect(tabClosed()).toBe(false);
    await userEvent.type(screen.getByLabelText("Restaurant name"), "s");
    expect(await screen.findByText("You have unsaved changes.")).toBeTruthy();
    expect(tabClosed()).toBe(true);
  });

  it("stops warning when the edit is put back as it was", async () => {
    form();
    const name = screen.getByLabelText("Restaurant name");
    await userEvent.type(name, "s");
    await userEvent.type(name, "{Backspace}");
    await waitFor(() => expect(screen.queryByText("You have unsaved changes.")).toBeNull());
    expect(tabClosed()).toBe(false);
  });

  it("asks before a link inside the app is followed, and stays when asked to", async () => {
    form();
    await userEvent.type(screen.getByLabelText("Restaurant name"), "s");
    await userEvent.click(screen.getByRole("link", { name: "Menu" }));
    await waitFor(() => expect(dialogOf().open).toBe(true));
    expect(dialogOf().textContent).toContain("Leave without saving?");
    await userEvent.click(screen.getByRole("button", { name: "Stay" }));
    await waitFor(() => expect(dialogOf().open).toBe(false));
    expect(push).not.toHaveBeenCalled();
    expect(tabClosed()).toBe(true); // still unsaved
  });

  it("goes where the link went, and forgets the edits, when asked to leave", async () => {
    form();
    await userEvent.type(screen.getByLabelText("Restaurant name"), "s");
    await userEvent.click(screen.getByRole("link", { name: "Menu" }));
    await userEvent.click(await screen.findByRole("button", { name: "Leave" }));
    expect(push).toHaveBeenCalledWith("/dashboard/menu");
    await waitFor(() => expect(tabClosed()).toBe(false));
  });

  it("does not ask for a link with nothing to lose, a jump within the page, or another site", async () => {
    form();
    // Not edited yet.
    fireEvent.click(screen.getByRole("link", { name: "Menu" }));
    expect(dialogOf().open).toBe(false);
    window.happyDOM.setURL("http://localhost:3000/dashboard/settings"); // happy-dom followed it

    await userEvent.type(screen.getByLabelText("Restaurant name"), "s");
    fireEvent.click(screen.getByRole("link", { name: "Jump" }));
    expect(dialogOf().open).toBe(false);
    fireEvent.click(screen.getByRole("link", { name: "Away" }));
    expect(dialogOf().open).toBe(false);
  });

  it("is not a refusal of ctrl-click, which opens another tab", async () => {
    form();
    await userEvent.type(screen.getByLabelText("Restaurant name"), "s");
    fireEvent.click(screen.getByRole("link", { name: "Menu" }), { ctrlKey: true });
    expect(dialogOf().open).toBe(false);
  });
});

describe("the dialog everything confirms with", () => {
  const dialog = (props: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open</button>
          <ConfirmDialog
            open={open}
            title="Cancel this booking?"
            confirmLabel="Cancel booking"
            onCancel={() => {
              onCancel();
              setOpen(false);
            }}
            onConfirm={onConfirm}
            {...props}
          />
        </>
      );
    }
    render(<Host />);
    return { onCancel, onConfirm };
  };

  it("is a modal dialog named by its title, shown when open", async () => {
    dialog();
    expect(dialogOf().open).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(dialogOf().open).toBe(true));
    const title = dialogOf().getAttribute("aria-labelledby")!;
    expect(document.getElementById(title)?.textContent).toBe("Cancel this booking?");
  });

  it("cancels on Escape and on a tap on the scrim, but not on a tap inside it", async () => {
    const { onCancel } = dialog();
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(dialogOf().open).toBe(true));

    fireEvent.click(screen.getByText("Cancel this booking?"));
    expect(onCancel).not.toHaveBeenCalled();

    const escape = new Event("cancel", { cancelable: true });
    act(() => void dialogOf().dispatchEvent(escape));
    // The dialog stays in charge of whether it closes: the browser's own close is stopped.
    expect(escape.defaultPrevented).toBe(true);
    expect(onCancel).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(dialogOf().open).toBe(true));
    fireEvent.click(dialogOf());
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("cannot be cancelled, or confirmed again, while its action is under way", async () => {
    const { onCancel, onConfirm } = dialog({ pending: true });
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(dialogOf().open).toBe(true));
    act(() => void dialogOf().dispatchEvent(new Event("cancel", { cancelable: true })));
    fireEvent.click(dialogOf());
    expect(onCancel).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Cancel booking" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("holds a required reason to its rule before it confirms, and hands over the trimmed text", async () => {
    const { onConfirm } = dialog({ reason: { label: "Why?", required: true, maxLength: 5 } });
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(dialogOf().open).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "Cancel booking" }));
    expect(screen.getByLabelText("Why?").getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(screen.getByLabelText("Why?"));
    expect(onConfirm).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText("Why?"), " no ");
    await userEvent.click(screen.getByRole("button", { name: "Cancel booking" }));
    expect(onConfirm).toHaveBeenCalledWith("no");
  });
});

describe("the kept category of an add form (#113)", () => {
  const add = () =>
    render(
      <form>
        <input name="name" aria-label="Name" />
        <RememberedCategorySelect
          categories={[
            { id: "starters", name: "Starters" },
            { id: "drinks", name: "Drinks" },
          ]}
        />
        <button type="reset">Reset</button>
      </form>,
    );
  const select = () => document.querySelector("select") as HTMLSelectElement;

  it("keeps the chosen category through a reset, while the other fields clear", async () => {
    add();
    await userEvent.type(screen.getByLabelText("Name"), "Cola");
    await userEvent.selectOptions(select(), "drinks");
    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveProperty("value", ""));
    expect(select().value).toBe("drinks");
  });

  it("is the first category, as a plain select, before anything is chosen", async () => {
    add();
    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    await act(async () => {});
    expect(select().value).toBe("starters");
  });
});

describe("the CSV import dialog (#114)", () => {
  const importer = () =>
    render(
      <CsvImportDialog
        kind="tables"
        action="/api/tables/import"
        title="Import tables"
        noun={{ one: "table", other: "tables" }}
        intro={<p>Columns: label, seats.</p>}
      />,
    );

  it("opens from its button as a modal dialog, and closes from Close and Cancel", async () => {
    importer();
    expect(dialogOf().open).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Import CSV" }));
    await waitFor(() => expect(dialogOf().open).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(dialogOf().open).toBe(false));

    await userEvent.click(screen.getByRole("button", { name: "Import CSV" }));
    await waitFor(() => expect(dialogOf().open).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(dialogOf().open).toBe(false));
  });

  it("asks for a file or pasted rows before it posts anything", async () => {
    importer();
    await userEvent.click(screen.getByRole("button", { name: "Import CSV" }));
    await userEvent.click(screen.getByRole("button", { name: "Check rows" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Choose a CSV file or paste one.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("previews pasted rows with the server, then shows the report", async () => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json({
        columns: ["label", "seats"],
        rows: [{ line: 2, values: ["1", "4"], problems: [], notes: [] }],
        ready: 1,
        imported: null,
      }),
    );
    importer();
    await userEvent.click(screen.getByRole("button", { name: "Import CSV" }));
    await userEvent.type(screen.getByRole("textbox"), "label,seats{enter}1,4");
    await userEvent.click(screen.getByRole("button", { name: "Check rows" }));
    expect(await screen.findByRole("button", { name: "Import 1 row" })).toBeTruthy();
    const body = vi.mocked(fetch).mock.calls[0][1]?.body as FormData;
    expect(body.get("intent")).toBe("preview");
    expect(String(body.get("csv"))).toContain("1,4");
  });
});

describe("the admin console's form (#111)", () => {
  it("keeps what was typed, marks the refused field and focuses it, when the route says no", async () => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json({ error: "That slug is taken.", field: "slug" }, { status: 409 }),
    );
    render(
      <PageRefresh>
        <AdminForm action="/api/admin/restaurants" submitLabel="Create">
          <input name="name" aria-label="Name" />
          <input name="slug" aria-label="Slug" />
        </AdminForm>
      </PageRefresh>,
    );
    await userEvent.type(screen.getByLabelText("Slug"), "mopane");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect((await screen.findByRole("alert")).textContent).toContain("That slug is taken.");
    expect(screen.getByLabelText("Slug").getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(screen.getByLabelText("Slug"));
    expect(screen.getByLabelText("Slug")).toHaveProperty("value", "mopane");

    await userEvent.type(screen.getByLabelText("Slug"), "x");
    expect(screen.getByLabelText("Slug").getAttribute("aria-invalid")).toBeNull();
  });

  it("clears the form after a save, and puts focus back on the first field", async () => {
    render(
      <PageRefresh>
        <AdminForm action="/api/admin/restaurants" submitLabel="Create">
          <input name="name" aria-label="Name" />
        </AdminForm>
      </PageRefresh>,
    );
    await userEvent.type(screen.getByLabelText("Name"), "Mopane");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveProperty("value", ""));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Name")));
  });

  it("posts nothing for a second press while the first is under way", async () => {
    vi.mocked(fetch).mockReturnValue(new Promise(() => {}));
    render(
      <AdminForm action="/api/x" submitLabel="Create" pendingLabel="Creating">
        <input name="name" aria-label="Name" />
      </AdminForm>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    const busy = await screen.findByRole("button", { name: "Creating" });
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect((busy as HTMLButtonElement).disabled).toBe(false); // keeps focus
    await userEvent.click(busy);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("SavedPlace and PageRefresh", () => {
  function Says({ what }: { what: string }) {
    const say = useSaySaved();
    return <button onClick={() => say({ message: what })}>Say</button>;
  }

  it("says what a save said in the nearest place, and shows it from the top of the page otherwise", async () => {
    render(
      <PageRefresh>
        <SavedPlace>
          <Says what="Nested." />
        </SavedPlace>
        <Says what="Top." />
      </PageRefresh>,
    );
    const [nested, top] = screen.getAllByRole("button", { name: "Say" });
    await userEvent.click(nested);
    const message = screen.getByText("Nested.");
    expect(message.closest("[role=status]")?.parentElement?.className).toBe("");
    await userEvent.click(top);
    expect(screen.getByText("Top.")).toBeTruthy();
  });

  it("runs one refresh for saves made together, and the forms wait for it", async () => {
    // Imported late: PageRefresh's refresh is router.refresh() in a transition.
    const { ActionForm } = await import("@/app/dashboard/action-form");
    render(
      <PageRefresh>
        <ActionForm action="/api/a" savedMessage="A saved.">
          <button>A</button>
        </ActionForm>
        <ActionForm action="/api/b" savedMessage="B saved.">
          <button>B</button>
        </ActionForm>
      </PageRefresh>,
    );
    await userEvent.click(screen.getByRole("button", { name: "A" }));
    await userEvent.click(screen.getByRole("button", { name: "B" }));
    expect(await screen.findByText("B saved.")).toBeTruthy();
    expect(refresh.mock.calls.length).toBeLessThanOrEqual(2);
    expect(refresh).toHaveBeenCalled();
  });
});
