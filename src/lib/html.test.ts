import { describe, expect, it } from "vitest";
import { html } from "./html";

describe("html", () => {
  it("escapes what it's given", () => {
    expect(String(html`<p>${`<script>"a" & 'b'</script>`}</p>`)).toBe(
      "<p>&lt;script&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/script&gt;</p>",
    );
  });

  it("escapes inside an attribute", () => {
    expect(String(html`<a title="${'" onload="x'}">`)).toBe(
      '<a title="&quot; onload=&quot;x">',
    );
  });

  it("doesn't escape its own output twice", () => {
    expect(String(html`<ul>${html`<li>${"<"}</li>`}</ul>`)).toBe(
      "<ul><li>&lt;</li></ul>",
    );
  });

  it("joins a list", () => {
    const items = ["a", "<b>"].map((item) => html`<li>${item}</li>`);
    expect(String(html`<ul>${items}</ul>`)).toBe(
      "<ul><li>a</li><li>&lt;b&gt;</li></ul>",
    );
  });

  it.each([[null], [undefined], [false]] as const)("leaves out %s, for conditions", (value) => {
    expect(String(html`<p>${value}</p>`)).toBe("<p></p>");
  });

  it("escapes a string pretending to be its output", () => {
    const forged = { value: "<script>", toString: () => "<script>" };
    expect(String(html`${forged as unknown as string}`)).toBe("&lt;script&gt;");
  });
});
