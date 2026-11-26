import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActionForm, PageRefusalAlert, PageRefusals } from "@/app/dashboard/action-form";
import { PageRefresh } from "@/app/page-refresh";
import { CONFIRMED_FIELD } from "@/lib/confirmation";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
  usePathname: () => "/dashboard/test",
  useSearchParams: () => new URLSearchParams(),
}));

/** What the next posts answer, in order; the last one repeats. */
let answers: Response[] = [];
const posts = () => vi.mocked(fetch).mock.calls;
const bodyOf = (call: number) => posts()[call][1]?.body as FormData;
const answer = (...responses: Response[]) => (answers = responses);
const refusal = (error: string, extra: object = {}) =>
  Response.json({ error, ...extra }, { status: 409 });

beforeEach(() => {
  refresh.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => (answers.length > 1 ? answers.shift()! : answers[0]).clone()),
  );
  answer(new Response(null, { status: 204 }));
});

/** The page's own refresh, as the dashboard layout has it. */
const onPage = (children: ReactNode) => <PageRefresh>{children}</PageRefresh>;

describe("keepOnReset", () => {
  const form = (keepOnReset?: string[]) =>
    render(
      onPage(
        <ActionForm action="/api/bookings" resetOnSuccess keepOnReset={keepOnReset}>
          <input name="guest" aria-label="Guest" />
          <input name="time" aria-label="Time" />
          <select name="tableId" aria-label="Table">
            <option value="">Any</option>
            <option value="t7">T7</option>
          </select>
          <button>Add booking</button>
        </ActionForm>,
      ),
    );

  it("clears the form after a save, except the fields it was told to keep", async () => {
    const user = userEvent.setup();
    form(["time", "tableId"]);
    await user.type(screen.getByLabelText("Guest"), "Blessing");
    await user.type(screen.getByLabelText("Time"), "19:00");
    await user.selectOptions(screen.getByLabelText("Table"), "t7");

    await user.click(screen.getByRole("button", { name: "Add booking" }));

    await waitFor(() => expect(screen.getByLabelText("Guest")).toHaveProperty("value", ""));
    expect(screen.getByLabelText("Time")).toHaveProperty("value", "19:00");
    expect(screen.getByLabelText("Table")).toHaveProperty("value", "t7");
  });

  it("clears every field when it is told to keep none", async () => {
    const user = userEvent.setup();
    form();
    await user.type(screen.getByLabelText("Time"), "19:00");
    await user.click(screen.getByRole("button", { name: "Add booking" }));
    await waitFor(() => expect(screen.getByLabelText("Time")).toHaveProperty("value", ""));
  });

  it("keeps what was typed after a refusal, kept fields or not", async () => {
    answer(refusal("That table is taken."));
    const user = userEvent.setup();
    form(["time"]);
    await user.type(screen.getByLabelText("Guest"), "Blessing");
    await user.click(screen.getByRole("button", { name: "Add booking" }));
    expect((await screen.findByRole("alert")).textContent).toContain("That table is taken.");
    expect(screen.getByLabelText("Guest")).toHaveProperty("value", "Blessing");
  });
});

describe("refreshOnRefusal", () => {
  const form = (refreshOnRefusal: boolean) =>
    render(
      onPage(
        <ActionForm action="/api/walk-ins" refreshOnRefusal={refreshOnRefusal}>
          <button>Seat</button>
        </ActionForm>,
      ),
    );

  it("reloads the page's data after a refusal, so the list shows what the refusal found out", async () => {
    answer(refusal("That table was just taken."));
    form(true);
    await userEvent.click(screen.getByRole("button", { name: "Seat" }));
    expect((await screen.findByRole("alert")).textContent).toContain("That table was just taken.");
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it("leaves the page alone after a refusal without it", async () => {
    answer(refusal("That table was just taken."));
    form(false);
    await userEvent.click(screen.getByRole("button", { name: "Seat" }));
    await screen.findByRole("alert");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not reload twice for a refusal that already says the page is stale", async () => {
    answer(refusal("Out of date.", { refresh: true }));
    form(true);
    await userEvent.click(screen.getByRole("button", { name: "Seat" }));
    await screen.findByRole("alert");
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });
});

describe("a save waits for the page, then says what it saved (#111)", () => {
  it("is disabled and holds focus on 'Saving' until the refresh has rendered, then gives focus back", async () => {
    const user = userEvent.setup();
    let rendered!: () => void;
    refresh.mockImplementation(() => new Promise<void>((resolve) => (rendered = resolve)));
    // No PageRefresh: the form waits on router.refresh() itself, which the test holds.
    render(
      <ActionForm action="/api/x" savedMessage="Saved the thing.">
        <input name="name" aria-label="Name" />
        <button>Save</button>
      </ActionForm>,
    );
    const save = screen.getByRole("button", { name: "Save" });
    await user.click(save);

    // The disabled fieldset dropped focus, so it waits in the form.
    await waitFor(() => expect(screen.getByLabelText("Name").closest("fieldset")?.disabled).toBe(true));
    expect(document.activeElement).toBe(screen.getByText("Saving"));
    expect(screen.queryByText("Saved the thing.")).toBeNull();

    await act(async () => rendered());
    expect(await screen.findByText("Saved the thing.")).toBeTruthy();
    expect(document.activeElement).toBe(save);
    expect(screen.getByLabelText("Name").closest("fieldset")?.disabled).toBe(false);
    expect(screen.queryByText("Saving")).toBeNull();
  });

  it("keeps the buttons outside its fieldset enabled but aria-disabled, so they keep focus", async () => {
    const user = userEvent.setup();
    refresh.mockImplementation(() => new Promise(() => {}));
    render(
      <>
        <ActionForm id="row" action="/api/x">
          <input name="name" aria-label="Name" />
        </ActionForm>
        <button form="row">Send from outside</button>
      </>,
    );
    const outside = screen.getByRole("button", { name: "Send from outside" });
    await user.click(outside);
    await waitFor(() => expect(outside.getAttribute("aria-disabled")).toBe("true"));
    expect((outside as HTMLButtonElement).disabled).toBe(false);
    expect(document.activeElement).toBe(outside);
  });

  it("says 'Done.' to screen readers when a save has no message of its own", async () => {
    render(
      onPage(
        <ActionForm action="/api/x">
          <button>Save</button>
        </ActionForm>,
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("Done.")).toBeTruthy());
    expect(screen.getByText("Done.").closest("[role=status]")?.className).toContain("sr-only");
  });

  it("puts focus on what took the place of a row the save removed", async () => {
    const user = userEvent.setup();
    function Rows() {
      const [rows, setRows] = useState(["one", "two", "three"]);
      refresh.mockImplementation(() => setRows((now) => now.filter((row) => row !== "two")));
      return (
        <ul>
          {rows.map((row) => (
            <li key={row}>
              <ActionForm action={`/api/rows/${row}`}>
                <button>Delete {row}</button>
              </ActionForm>
            </li>
          ))}
        </ul>
      );
    }
    render(onPage(<Rows />));
    await user.click(screen.getByRole("button", { name: "Delete two" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Delete two" })).toBeNull());
    await waitFor(() => expect(document.activeElement?.tagName).not.toBe("BODY"));
    // Never on another page's control; here the row that moved up, or the list around it.
    const now = document.activeElement as Element;
    expect(now.closest("ul")).not.toBeNull();
  });

  it("does not take focus back from a person who has moved on", async () => {
    const user = userEvent.setup();
    render(
      onPage(
        <>
          <ActionForm action="/api/x">
            <button>Save</button>
          </ActionForm>
          <input aria-label="Elsewhere" />
        </>,
      ),
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    screen.getByLabelText("Elsewhere").focus();
    await waitFor(() => expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false));
    expect(document.activeElement).toBe(screen.getByLabelText("Elsewhere"));
  });

  it("a second tap while it is pending posts nothing", async () => {
    refresh.mockImplementation(() => new Promise(() => {}));
    render(
      <ActionForm action="/api/x">
        <button>Save</button>
      </ActionForm>,
    );
    const save = screen.getByRole("button", { name: "Save" });
    await userEvent.click(save);
    await userEvent.click(save);
    expect(posts()).toHaveLength(1);
  });
});

describe("the in-page dialogs of a form (S-41, #112)", () => {
  it("asks first, posts nothing until confirmed, and posts the reason typed with the form", async () => {
    const user = userEvent.setup();
    render(
      onPage(
        <ActionForm
          action="/api/order-items/1/void"
          confirmation={{
            title: "Void this item?",
            confirmLabel: "Void item",
            reason: { label: "Why void it?", required: true, maxLength: 20 },
          }}
        >
          <button>Void</button>
        </ActionForm>,
      ),
    );
    const dialog = document.querySelector("dialog") as HTMLDialogElement;
    expect(dialog.open).toBe(false);

    await user.click(screen.getByRole("button", { name: "Void" }));
    await waitFor(() => expect(dialog.open).toBe(true));
    expect(posts()).toHaveLength(0);

    // The reason is required, checked in the dialog.
    await user.click(screen.getByRole("button", { name: "Void item" }));
    expect(dialog.textContent).toContain("Give a reason.");
    expect(posts()).toHaveLength(0);

    await user.type(screen.getByLabelText("Why void it?"), "  Dropped  ");
    await user.click(screen.getByRole("button", { name: "Void item" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(bodyOf(0).get("reason")).toBe("  Dropped  ");
    await waitFor(() => expect(dialog.open).toBe(false));
  });

  it("closes without posting on Cancel and on Escape, and the reason typed is gone next time", async () => {
    const user = userEvent.setup();
    render(
      onPage(
        <ActionForm
          action="/api/x"
          confirmation={{ title: "Archive it?", confirmLabel: "Archive", reason: { label: "Why?" } }}
        >
          <button>Archive…</button>
        </ActionForm>,
      ),
    );
    const dialog = document.querySelector("dialog") as HTMLDialogElement;
    await user.click(screen.getByRole("button", { name: "Archive…" }));
    await waitFor(() => expect(dialog.open).toBe(true));
    await user.type(screen.getByLabelText("Why?"), "no");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(dialog.open).toBe(false));

    // The dialog's `close` event, which clears it, is queued by the browser.
    await waitFor(() => expect(screen.getByLabelText("Why?")).toHaveProperty("value", ""));
    await user.click(screen.getByRole("button", { name: "Archive…" }));
    await waitFor(() => expect(dialog.open).toBe(true));
    // Escape is the dialog's `cancel` event; the form stays in charge of whether it closes.
    act(() => void dialog.dispatchEvent(new Event("cancel", { cancelable: true })));
    await waitFor(() => expect(dialog.open).toBe(false));
    expect(posts()).toHaveLength(0);
  });

  it("asks 'Save anyway?' on a warning, and posts again marked as confirmed", async () => {
    const user = userEvent.setup();
    answer(
      refusal("The USD price is 0.", { confirm: { warnings: ["The USD price is 0."] } }),
      new Response(null, { status: 204 }),
    );
    render(
      onPage(
        <ActionForm action="/api/menu/items">
          <input name="price" aria-label="Price" defaultValue="0" />
          <button>Save</button>
        </ActionForm>,
      ),
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    const dialog = document.querySelector("dialog") as HTMLDialogElement;
    await waitFor(() => expect(dialog.open).toBe(true));
    // A warning is not a refusal: nothing red on the page.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(bodyOf(0).get(CONFIRMED_FIELD)).toBeNull();

    await user.click(screen.getByRole("button", { name: "Save anyway" }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(bodyOf(1).get(CONFIRMED_FIELD)).toBe("1");
    expect(bodyOf(1).get("price")).toBe("0");
  });
});

describe("one refusal at a time", () => {
  it("clears a form's refusal when another form on the page is sent", async () => {
    const user = userEvent.setup();
    answer(refusal("No."), new Response(null, { status: 204 }));
    render(
      onPage(
        <>
          <ActionForm action="/api/a">
            <button>A</button>
          </ActionForm>
          <ActionForm action="/api/b">
            <button>B</button>
          </ActionForm>
        </>,
      ),
    );
    await user.click(screen.getByRole("button", { name: "A" }));
    expect((await screen.findByRole("alert")).textContent).toContain("No.");
    await user.click(screen.getByRole("button", { name: "B" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("says that the server could not be reached, keeping the form", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("offline"));
    render(
      onPage(
        <ActionForm action="/api/a">
          <input name="x" aria-label="X" defaultValue="kept" />
          <button>A</button>
        </ActionForm>,
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: "A" }));
    expect((await screen.findByRole("alert")).textContent).toContain("That didn't reach the server.");
    expect(screen.getByLabelText("X")).toHaveProperty("value", "kept");
  });
});

describe("PageRefusals (#102)", () => {
  const screenOf = (props: { refusalOnPage?: boolean } = {}) =>
    render(
      onPage(
        <PageRefusals>
          <PageRefusalAlert />
          <ActionForm action="/api/archive" {...props}>
            <button>Archive</button>
          </ActionForm>
          <ActionForm action="/api/other">
            <button>Other</button>
          </ActionForm>
        </PageRefusals>,
      ),
    );

  it("shows a stale refusal on the page, not the form, and reloads the page it came from", async () => {
    answer(refusal("That changed. Check again.", { refresh: true }));
    screenOf();
    await userEvent.click(screen.getByRole("button", { name: "Archive" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("That changed. Check again.");
    expect(alert.closest("fieldset")).toBeNull();
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it("shows an ordinary refusal in the form, unless the form says refusalOnPage", async () => {
    answer(refusal("Not now."));
    const { unmount } = screenOf();
    await userEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect((await screen.findByRole("alert")).closest("fieldset")).not.toBeNull();
    expect(refresh).not.toHaveBeenCalled();
    unmount();

    screenOf({ refusalOnPage: true });
    await userEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect((await screen.findByRole("alert")).closest("fieldset")).toBeNull();
  });

  it("clears the page's refusal when any form is sent", async () => {
    answer(refusal("That changed.", { refresh: true }), new Response(null, { status: 204 }));
    screenOf();
    await userEvent.click(screen.getByRole("button", { name: "Archive" }));
    await screen.findByRole("alert");
    await userEvent.click(screen.getByRole("button", { name: "Other" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});
