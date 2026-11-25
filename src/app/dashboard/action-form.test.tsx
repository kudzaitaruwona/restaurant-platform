import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ActionForm, confirmationOf, refusalFrom } from "./action-form";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));

describe("an action form's confirmation (S-41)", () => {
  it("asks in an in-page dialog inside the form, not the browser's confirm()", () => {
    const html = renderToStaticMarkup(
      <ActionForm id="void-1" action="/api/order-items/1/void" confirmation={{
        title: "Void this item?",
        confirmLabel: "Void item",
        reason: { label: "Why void it?", maxLength: 200, required: true },
      }}>
        <input type="hidden" name="x" value="1" />
      </ActionForm>,
    );
    const form = /^<form[^>]*>/.exec(html)?.[0] ?? "";
    expect(form).toContain('id="void-1"');
    expect(form).toContain('method="post"');
    expect(form).toContain('action="/api/order-items/1/void"');
    expect(html).toMatch(/<dialog[^>]*>.*Void this item\?.*<textarea[^>]*name="reason".*<\/dialog><\/form>$/);
  });

  it("has no dialog without a confirmation", () => {
    const html = renderToStaticMarkup(<ActionForm action="/api/x"><button>Save</button></ActionForm>);
    expect(html).not.toContain("<dialog");
  });

  it("turns a plain-text confirmation into the dialog's question", () => {
    expect(confirmationOf("Archive Mopane chips? Customers will stop seeing it.")).toEqual({
      title: "Archive Mopane chips? Customers will stop seeing it.",
      confirmLabel: "Confirm",
      cancelLabel: "Go back",
    });
  });
});

describe("a save the server asks about first (issue #112)", () => {
  it("reads a 409's warnings, so the form can ask and post again", async () => {
    const response = Response.json(
      { error: "The USD price is 0.", confirm: { warnings: ["The USD price is 0.", 7] } },
      { status: 409 },
    );
    expect(await refusalFrom(response)).toMatchObject({ warnings: ["The USD price is 0."] });
  });

  it("keeps a booking's link only when it goes to the dashboard", async () => {
    const refusal = await refusalFrom(
      Response.json(
        {
          error: "In the way.",
          bookings: [
            { id: "a", summary: "A", href: "/dashboard/bookings?date=2026-12-01#booking-a" },
            { id: "b", summary: "B", href: "https://evil.example/" },
            { id: "c", summary: "C", href: "//evil.example/dashboard/x" },
            { id: "d", summary: "D" },
          ],
        },
        { status: 409 },
      ),
    );
    expect(refusal.bookings).toEqual([
      { id: "a", summary: "A", href: "/dashboard/bookings?date=2026-12-01#booking-a" },
      { id: "b", summary: "B" },
      { id: "c", summary: "C" },
      { id: "d", summary: "D" },
    ]);
  });

  it("is an ordinary refusal when there is nothing to confirm", async () => {
    const refusal = await refusalFrom(Response.json({ error: "No." }, { status: 409 }));
    expect(refusal).toEqual({ message: "No.", bookings: [], warnings: [] });
  });
});
