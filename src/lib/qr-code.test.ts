import { describe, expect, it } from "vitest";
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
});
