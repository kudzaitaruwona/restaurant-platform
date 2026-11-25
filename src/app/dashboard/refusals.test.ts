import { describe, expect, it } from "vitest";
import { type Refusal, announceSend, clearOnOtherSend, pageRefusal, refusalPlace } from "./refusals";

describe("one refusal at a time", () => {
  it("clears a form's refusal when another form is sent, not when itself is", () => {
    const a = Symbol("a");
    const b = Symbol("b");
    let clearedA = 0;
    let clearedB = 0;
    const offA = clearOnOtherSend(a, () => clearedA++);
    const offB = clearOnOtherSend(b, () => clearedB++);
    announceSend(b);
    expect([clearedA, clearedB]).toEqual([1, 0]);
    announceSend(a);
    expect([clearedA, clearedB]).toEqual([1, 1]);
    offA();
    announceSend(b);
    expect(clearedA).toBe(1);
    offB();
  });
});

const refused = (message: string, refresh = false): Refusal => ({ message, bookings: [], warnings: [], refresh });

describe("the page's own place for a refusal (#102)", () => {
  it("keeps a refusal whatever becomes of the form that met it, until the next send", () => {
    const page = pageRefusal();
    let changes = 0;
    const off = page.subscribe(() => changes++);
    const stale = refused("This item is already voided.", true);

    page.show(stale);
    expect(page.get()).toBe(stale);
    expect(changes).toBe(1);

    announceSend(Symbol("any form, the same one too"));
    expect(page.get()).toBeUndefined();
    expect(changes).toBe(2);
    off();
  });

  it("is empty when its page is shown again, and takes nothing while it is hidden", () => {
    const page = pageRefusal();
    const off = page.subscribe(() => {});
    page.show(refused("Nope."));
    off();
    expect(page.get()).toBeUndefined();

    page.show(refused("A late answer."));
    expect(page.get()).toBeUndefined();
  });

  it("takes a stale form's refusal, and any from a form that asks for it", () => {
    expect(refusalPlace(refused("Stale.", true), { page: true, onPage: false })).toBe("page");
    expect(refusalPlace(refused("No."), { page: true, onPage: true })).toBe("page");
    expect(refusalPlace(refused("No."), { page: true, onPage: false })).toBe("form");
    expect(refusalPlace(refused("Stale.", true), { page: false, onPage: true })).toBe("form");
  });
});
