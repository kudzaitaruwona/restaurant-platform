import { describe, expect, it } from "vitest";
import QRCode from "qrcode";
import { menuCodeUrl, qrSvg, tableCodeUrl } from "./qr-code";

describe("tableCodeUrl", () => {
  it("is the app's address, /t/ and the token, and nothing else", () => {
    expect(tableCodeUrl("https://example.test", "abc")).toBe("https://example.test/t/abc");
  });

  it("doesn't double the slash when the address ends in one", () => {
    expect(tableCodeUrl("https://example.test/", "abc")).toBe("https://example.test/t/abc");
  });
});

describe("qrSvg", () => {
  it("is an SVG", async () => {
    const svg = await qrSvg("https://example.test/t/abc");
    expect(svg).toMatch(/^<svg[^>]*viewBox=/);
    expect(svg).not.toMatch(/<script/);
  });

  it("is a different picture for a different token", async () => {
    expect(await qrSvg("https://example.test/t/abc")).not.toBe(
      await qrSvg("https://example.test/t/abd"),
    );
  });

  it("uses error-correction level M, the spec's level", async () => {
    const text = "https://example.test/t/abc";
    const options = { type: "svg", margin: 4 } as const;

    expect(await qrSvg(text)).toBe(
      await QRCode.toString(text, { ...options, errorCorrectionLevel: "M" }),
    );
    // A different level draws a different picture, so the line above can fail.
    expect(await qrSvg(text)).not.toBe(
      await QRCode.toString(text, { ...options, errorCorrectionLevel: "L" }),
    );
  });
});

describe("menuCodeUrl", () => {
  it("is the app's address, /m/ and the menu token", () => {
    expect(menuCodeUrl("https://example.test/", "tok")).toBe("https://example.test/m/tok");
  });
});

describe("the quiet zone", () => {
  it("is 4 modules on every side, the standard", async () => {
    const text = "https://example.test/t/abc";
    const modules = QRCode.create(text, { errorCorrectionLevel: "M" }).modules.size;

    const svg = await qrSvg(text);

    expect(svg).toContain(`viewBox="0 0 ${modules + 8} ${modules + 8}"`);
  });
});
