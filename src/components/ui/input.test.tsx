import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Field, Input } from "./input";

const field = (error?: string) =>
  renderToStaticMarkup(
    <Field label="Name" error={error} errorId="name-error">
      <Input name="name" aria-describedby={error && "name-error"} />
    </Field>,
  );

describe("Field", () => {
  it("keeps a refusal out of the label, so it describes the control and doesn't name it", () => {
    const html = field("Enter a name.");
    const [label] = /<label[\s\S]*<\/label>/.exec(html)!;
    expect(label).not.toContain("Enter a name.");
    expect(html).toMatch(/<span id="name-error" role="alert"[^>]*>Enter a name\.<\/span>/);
  });

  it("wraps the label the same way with and without a refusal, so the control isn't remounted", () => {
    const [before] = /^.*?<input/.exec(field())!;
    expect(field("Enter a name.").startsWith(before)).toBe(true);
    expect(field()).not.toContain("role=\"alert\"");
  });
});
