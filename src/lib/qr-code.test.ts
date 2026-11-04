import { describe, expect, it } from "vitest";
import QRCode from "qrcode";
import { qrSvg, tableCodeUrl } from "./qr-code";

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
    const options = { type: "svg", margin: 1 } as const;

    expect(await qrSvg(text)).toBe(
      await QRCode.toString(text, { ...options, errorCorrectionLevel: "M" }),
    );
    // A different level draws a different picture, so the line above can fail.
    expect(await qrSvg(text)).not.toBe(
      await QRCode.toString(text, { ...options, errorCorrectionLevel: "L" }),
    );
  });
});
