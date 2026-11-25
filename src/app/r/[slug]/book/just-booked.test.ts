import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bookedPath, canGoForward, forgetBooked, isLeftOver, rememberBooked } from "./just-booked";

const ACTION = "/api/r/mbira/book";
const stored = new Map<string, string>();

/** This document: when it loaded, and how the guest got to it. */
const loaded = (timeOrigin: number, type: string) =>
  vi.stubGlobal("performance", { timeOrigin, getEntriesByType: () => [{ type }] });

beforeEach(() => {
  stored.clear();
  vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  });
  loaded(900_000, "navigate");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a booking form after booking (#89)", () => {
  it("is live before anything is booked, however it was reached", () => {
    for (const type of ["navigate", "reload", "back_forward"]) {
      loaded(900_000, type);
      expect(isLeftOver(ACTION)).toBe(false);
    }
  });

  it("is left over in a page the browser kept from before the booking", () => {
    rememberBooked(ACTION);
    expect(isLeftOver(ACTION)).toBe(true);
  });

  it.each(["back_forward", "reload"])("is left over when the server sends it again by %s", (type) => {
    rememberBooked(ACTION);
    loaded(1_100_000, type);
    expect(isLeftOver(ACTION)).toBe(true);
  });

  it("is live when a link leads to it afterwards, and at another restaurant", () => {
    rememberBooked(ACTION);
    expect(isLeftOver("/api/r/other/book")).toBe(false);
    loaded(1_100_000, "navigate");
    expect(isLeftOver(ACTION)).toBe(false);
  });

  it("is live again once the guest asks for another booking", () => {
    rememberBooked(ACTION);
    forgetBooked(ACTION);
    expect(isLeftOver(ACTION)).toBe(false);
  });

  it("remembers only when, never the token", () => {
    rememberBooked(ACTION);
    expect([...stored.values()]).toEqual(["1000000"]);
  });

  it("is simply not guarded where storage is blocked", () => {
    vi.stubGlobal("sessionStorage", {
      getItem() { throw new Error("blocked"); },
      setItem() { throw new Error("blocked"); },
      removeItem() { throw new Error("blocked"); },
    });
    rememberBooked(ACTION);
    expect(isLeftOver(ACTION)).toBe(false);
    expect(() => forgetBooked(ACTION)).not.toThrow();
  });

  it.each([
    ["there is somewhere", { canGoForward: true }, true],
    ["there is nowhere", { canGoForward: false }, false],
    ["the browser can't say", undefined, false],
  ])("offers Forward only when the browser says there is somewhere to go: %s", (_, navigation, offered) => {
    vi.stubGlobal("window", { navigation });
    expect(canGoForward()).toBe(offered);
  });

  it("leads to the booking's own page", () => {
    expect(bookedPath("AbC-_1")).toBe("/b/AbC-_1?booked=1");
  });
});
