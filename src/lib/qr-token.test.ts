import { describe, expect, it } from "vitest";
import { mintQrToken } from "./qr-token";

describe("mintQrToken", () => {
  it("is 22 base62 characters, which is at least 128 bits", () => {
    const token = mintQrToken();
    expect(token).toMatch(/^[0-9A-Za-z]{22}$/);
    expect(22 * Math.log2(62)).toBeGreaterThanOrEqual(128);
  });

  it("is different every time", () => {
    const tokens = new Set(Array.from({ length: 1000 }, mintQrToken));
    expect(tokens.size).toBe(1000);
  });

  it("uses every character of the alphabet, evenly enough to show no bias", () => {
    const counts = new Map<string, number>();
    for (let n = 0; n < 5000; n += 1) {
      for (const character of mintQrToken()) {
        counts.set(character, (counts.get(character) ?? 0) + 1);
      }
    }
    expect(counts.size).toBe(62);
    // 110000 draws over 62 characters is about 1774 each.
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(1500);
      expect(count).toBeLessThan(2050);
    }
  });
});
