import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ActionForm, confirmationOf } from "./action-form";

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
