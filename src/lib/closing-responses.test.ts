import { describe, expect, it } from "vitest";
import { blockedBy, itemsChanged, reloadToClose, reopenRefused, sessionChanged } from "./closing-responses";

/** A stale page's refusal has ActionForm refresh the page (#95, #102). */
describe("refusals that say the page is out of date (#102)", () => {
  it.each([
    ["a missing session", () => reloadToClose()],
    ["a changed session", () => sessionChanged()],
    ["a table with items in the way: Clear is disabled while any is outstanding", () => blockedBy([])],
    ["a force-close whose items changed", () => itemsChanged([])],
    ["a reopen after the window", () => reopenRefused("too_late")],
    ["a reopen after a new party", () => reopenRefused("superseded")],
    ["a reopen of a session that changed", () => reopenRefused("session_changed")],
  ])("%s asks for a refresh", async (_name, make) => {
    const answer = await make().json();
    expect(answer).toMatchObject({ refresh: true });
    // It has just reloaded itself: don't send the reader to do it again.
    expect(answer.error).not.toMatch(/reload/i);
  });
});
