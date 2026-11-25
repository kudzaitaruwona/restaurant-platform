import { describe, expect, it } from "vitest";
import { reloadToClose, reopenRefused, sessionChanged } from "./closing-responses";

/** A stale page's refusal has ActionForm refresh the page (#95, #102). */
describe("refusals that say the page is out of date (#102)", () => {
  it.each([
    ["a missing session", () => reloadToClose()],
    ["a changed session", () => sessionChanged()],
    ["a reopen after the window", () => reopenRefused("too_late")],
    ["a reopen after a new party", () => reopenRefused("superseded")],
    ["a reopen of a session that changed", () => reopenRefused("session_changed")],
  ])("%s asks for a refresh", async (_name, make) => {
    expect(await make().json()).toMatchObject({ refresh: true });
  });
});

describe("the other refusals that say 'reload' (#102)", () => {
  it("ask for a refresh too: a taken table, and a booking that changed", async () => {
    const { walkInResponse } = await import("./walk-in-responses");
    const { bookingActionResponse } = await import("./booking-day-responses");
    const { moveBookingResponse } = await import("./booking-staff-responses");
    const request = new Request("http://localhost/x", { method: "POST" });

    expect(await walkInResponse({ outcome: "table_taken" } as never, request).json()).toMatchObject({ refresh: true });
    expect(
      await bookingActionResponse({ outcome: "wrong_status", status: "cancelled" } as never, request, "Seat").json(),
    ).toMatchObject({ refresh: true });
    expect(
      await moveBookingResponse({ outcome: "wrong_status", status: "cancelled" } as never, request).json(),
    ).toMatchObject({ refresh: true });
  });
});
