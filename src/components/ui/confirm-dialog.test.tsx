import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConfirmDialog, reasonProblem } from "./confirm-dialog";

/**
 * No DOM here, as for the other client components: the markup is checked as
 * rendered, and the decision about a typed reason in reasonProblem().
 */
const noop = () => {};

const render = (props: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) =>
  renderToStaticMarkup(
    <ConfirmDialog
      open={false}
      title="Cancel this booking?"
      description="Blessing Moyo, 19:00, party of 4 at T6. Their table is freed."
      confirmLabel="Cancel booking"
      cancelLabel="Keep booking"
      onConfirm={noop}
      onCancel={noop}
      {...props}
    />,
  );

describe("the confirm dialog", () => {
  it("is an in-page <dialog>, closed until asked, named by its question and described by what happens", () => {
    const html = render();
    expect(html).toMatch(/^<dialog/);
    expect(html).not.toMatch(/<dialog[^>]* open/);
    const labelledBy = /aria-labelledby="([^"]+)"/.exec(html)?.[1];
    const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(html).toMatch(new RegExp(`<h2 id="${labelledBy}"[^>]*>Cancel this booking\\?</h2>`));
    expect(html).toMatch(new RegExp(`id="${describedBy}"[^>]*>Blessing Moyo, 19:00`));
  });

  it("pads an inner box, not the dialog, so only a tap on the backdrop cancels", () => {
    const html = render();
    expect(html).toMatch(/^<dialog[^>]*class="[^"]*\bp-0\b/);
    expect(html).not.toMatch(/^<dialog[^>]*class="[^"]*\bp-6\b/);
    expect(html).toMatch(/^<dialog[^>]*><div class="p-6"><h2/);
  });

  it("offers the way back first and the action by name, in red by default", () => {
    const html = render();
    expect(html.indexOf("Keep booking")).toBeLessThan(html.indexOf("Cancel booking"));
    expect(html).toMatch(/<button[^>]*class="[^"]*bg-danger[^"]*"[^>]*>Cancel booking<\/button>/);
    expect(html).not.toContain("<textarea");
  });

  it("draws a non-destructive confirm in black", () => {
    expect(render({ tone: "primary", confirmLabel: "Make a new one" })).toMatch(
      /<button[^>]*class="[^"]*bg-brand[^"]*"[^>]*>Make a new one<\/button>/,
    );
  });

  it("asks for a reason in a labelled field that posts as `reason`, without the required attribute", () => {
    const html = render({ reason: { label: "Why void it?", maxLength: 200, required: true } });
    const field = /<textarea[^>]*>/.exec(html)?.[0] ?? "";
    expect(field).toContain('name="reason"');
    expect(field).toContain('maxLength="200"');
    expect(field).not.toContain("required");
    const id = /id="([^"]+)"/.exec(field)?.[1];
    expect(html).toMatch(new RegExp(`<label for="${id}"[^>]*>Why void it\\?</label>`));
  });

  it("posts the reason under the name given", () => {
    expect(render({ reason: { label: "Reason", name: "voidReason" } })).toContain('name="voidReason"');
  });

  it("disables both buttons while the action is under way", () => {
    expect(render({ pending: true }).match(/<button[^>]* disabled=""/g)).toHaveLength(2);
  });
});

describe("a typed reason", () => {
  const reason = { label: "Reason", required: true, maxLength: 10 };

  it("must be there when required, spaces not counting", () => {
    expect(reasonProblem("", reason)).toBe("Give a reason.");
    expect(reasonProblem("   ", reason)).toBe("Give a reason.");
    expect(reasonProblem("Sold out", reason)).toBeUndefined();
  });

  it("may be left blank when it isn't", () => {
    expect(reasonProblem("", { label: "Reason" })).toBeUndefined();
  });

  it("can't run past its limit", () => {
    expect(reasonProblem("x".repeat(11), reason)).toBe("Keep it to 10 characters.");
  });

  it("isn't asked for without a reason field", () => {
    expect(reasonProblem("", undefined)).toBeUndefined();
  });
});
