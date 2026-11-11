import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CodeInput, codeFrom, completes } from "./code-input";

const noop = () => {};

describe("the code input", () => {
  it("is one real input the platform can fill, behind six boxes that are only drawn", () => {
    const html = renderToStaticMarkup(
      <CodeInput value="12" onChange={noop} onComplete={noop} />,
    );
    expect(html.match(/<input/g)).toHaveLength(1);
    expect(html).toContain('autoComplete="one-time-code"');
    expect(html).toContain('inputMode="numeric"');
    expect(html).toContain('<div aria-hidden="true" class="grid grid-cols-6');
  });

  it("sets no maxlength, which would cut a pasted \"123 456\" before the space is dropped", () => {
    const html = renderToStaticMarkup(<CodeInput value="" onChange={noop} onComplete={noop} />);
    expect(html).not.toMatch(/maxLength|maxlength/);
  });

  it.each([
    ["123456", "123456"],
    ["123 456", "123456"],
    [" 12-34-56 ", "123456"],
    ["1234567", "123456"],
    ["abc", ""],
  ])("reads a paste of %j as %j", (raw, code) => {
    expect(codeFrom(raw)).toBe(code);
  });

  it("hands over on the sixth digit, once", () => {
    expect(completes("123456", "12345")).toBe(true);
    expect(completes("123456", "")).toBe(true); // a whole paste
    expect(completes("12345", "1234")).toBe(false);
    expect(completes("123456", "123456")).toBe(false);
  });
});
