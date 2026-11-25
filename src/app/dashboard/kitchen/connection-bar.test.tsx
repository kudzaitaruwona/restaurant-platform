import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConnectionBar } from "./connection-bar";

/**
 * No DOM here, so nothing is laid out: what keeps the rows still is that the bar's
 * outer element is the same, and takes no height, whatever the connection, and
 * that what it shows is out of the flow.
 */
const bar = (connection: "online" | "offline" | "signed_out") => {
  const html = renderToStaticMarkup(<ConnectionBar connection={connection} />);
  const end = html.indexOf(">") + 1;
  return { outer: html.slice(0, end), inner: html.slice(end) };
};

describe("the board's connection bar (#135)", () => {
  it("takes the same space, none, online, offline and signed out, so it never moves a row", () => {
    expect(bar("offline").outer).toBe(bar("online").outer);
    expect(bar("signed_out").outer).toBe(bar("online").outer);
    expect(bar("online").outer).toMatch(/class="[^"]*\bh-0\b/);
    expect(bar("offline").inner).toMatch(/^<div class="[^"]*\babsolute\b/);
  });

  it("is an alert that says what is wrong, and says nothing online", () => {
    expect(bar("online").outer).toContain('role="alert"');
    expect(bar("online").inner).toBe("</div>");
    expect(bar("offline").inner).toContain("Offline, reconnecting. The board may be out of date.");
    expect(bar("signed_out").inner).toContain("Signed out. Sign in again to keep the board live.");
  });
});
