import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ActionForm, RefusalAlert, confirmationOf, refusalFrom } from "./action-form";

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

  it("is an ordinary refusal when there is nothing to confirm", async () => {
    const refusal = await refusalFrom(Response.json({ error: "No." }, { status: 409 }));
    expect(refusal).toEqual({ message: "No.", bookings: [], warnings: [], refresh: false });
  });

  it("reads that the page is out of date, with the list now, so the form can refresh it (#95)", async () => {
    const items = [{ id: "1", summary: "1 × Rice for Chipo: placed" }];
    const refusal = await refusalFrom(Response.json({ error: "Changed.", items, refresh: true }, { status: 409 }));
    expect(refusal).toMatchObject({ bookings: items, refresh: true });
  });
});

describe("where a refusal sits (#102)", () => {
  const refusal = { message: "Nope.", bookings: [{ id: "1", summary: "2 x Stew" }], warnings: [], refresh: false };

  it("takes the caller's class, so a pinned bar can keep it out of its flow", () => {
    const html = renderToStaticMarkup(<RefusalAlert refusal={refusal} className="absolute bottom-full" />);
    expect(html).toMatch(/<div role="alert" class="[^"]*absolute bottom-full/);
    expect(html).toContain("Nope.");
    expect(html).toContain("2 x Stew");
  });
});
