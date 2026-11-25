import { describe, expect, it } from "vitest";
import { announceSend, clearOnOtherSend } from "./refusals";

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
