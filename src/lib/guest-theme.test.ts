import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { guestThemeCss, guestTokens } from "./guest-theme";

const globals = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

/**
 * The `--name: value` pairs of the block `selector` opens: its first use in the
 * file for :root, its last for the dark blocks (the dark variant at the top
 * uses the same media query).
 */
function tokensAfter(selector: string) {
  const start = selector === ":root {" ? globals.indexOf(selector) : globals.lastIndexOf(selector);
  const block = globals.slice(globals.indexOf("{", start) + 1, globals.indexOf("}", start));
  return Object.fromEntries(
    [...block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]),
  );
}

describe("the guest pages' theme (S-41)", () => {
  it.each([
    ["light", ":root {"],
    ["dark", "@media (prefers-color-scheme: dark) {"],
    ["dark", ':root:has([data-page-theme="dark"]) {'],
  ] as const)("has the staff app's %s tokens, value for value (%s)", (scheme, selector) => {
    const app = tokensAfter(selector);
    for (const [name, value] of Object.entries(guestTokens[scheme])) {
      expect(app[name], `--${name}`).toBe(value);
    }
  });

  it("follows the system's light or dark", () => {
    expect(guestThemeCss).toContain("@media (prefers-color-scheme:dark)");
  });

  it("loads no font and no other file", () => {
    expect(guestThemeCss).not.toMatch(/@import|@font-face|url\(/);
    expect(guestThemeCss).toContain("system-ui");
  });

  it("is small beside the 100KB page budget", () => {
    expect(new TextEncoder().encode(guestThemeCss).length).toBeLessThan(8 * 1024);
  });

  it("can't close the <style> it goes in", () => {
    expect(guestThemeCss).not.toMatch(/<\//);
  });
});
