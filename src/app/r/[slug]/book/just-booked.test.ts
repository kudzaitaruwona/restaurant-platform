import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bookedPath, bookingAhead, forgetBooked, isLeftOver, rememberBooked } from "./just-booked";

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

  it("leads to the booking's own page", () => {
    expect(bookedPath("AbC-_1")).toBe("/b/AbC-_1?booked=1");
  });
});

/** This tab's history as the Navigation API tells it, with the guest on entry `at`. */
const history = (urls: (string | null)[], at: number) => {
  const entries = urls.map((url, index) => ({ index, key: `slot${index}`, url }));
  vi.stubGlobal("window", { navigation: { entries: () => entries, currentEntry: entries[at] } });
};
const FORM = "http://localhost/r/mbira/book?party=2&date=2026-11-28&time=19:00";
const OTHER_FORM = "http://localhost/r/mbira/book?party=2&date=2026-11-28&time=18:00";
/** The manage page asks for its address to be hidden (Referrer-Policy: origin). */
const BOOKING = null;

describe("where the booking is, from a form the guest went back to (#134)", () => {
  it.each([
    ["it is the next page", [FORM, BOOKING], 0, "slot1"],
    ["another form is between, so Forward alone would lead to that", [OTHER_FORM, FORM, BOOKING], 0, "slot2"],
    ["the browser doesn't hide its address", [FORM, "http://localhost/b/AbC?booked=1"], 0, "slot1"],
    ["it is behind, and only another form is ahead", [BOOKING, FORM, OTHER_FORM], 1, undefined],
    ["there is nothing ahead", [FORM], 0, undefined],
    ["something else is ahead", [FORM, "http://localhost/r/b/book"], 0, undefined],
    ["it can't be told what is ahead", [FORM, "not a url"], 0, undefined],
  ])("%s", (_what, urls, at, key) => {
    history(urls, at);
    expect(bookingAhead()).toBe(key);
  });

  it("isn't known where the browser can't say", () => {
    vi.stubGlobal("window", {});
    expect(bookingAhead()).toBeUndefined();
    vi.stubGlobal("window", { navigation: { entries: () => [], currentEntry: null } });
    expect(bookingAhead()).toBeUndefined();
  });
});

describe("a booking form after booking, with storage blocked (#134)", () => {
  beforeEach(() => {
    vi.stubGlobal("sessionStorage", {
      getItem() { throw new Error("blocked"); },
      setItem() { throw new Error("blocked"); },
      removeItem() { throw new Error("blocked"); },
    });
    rememberBooked(ACTION);
  });

  it.each(["back_forward", "reload"])("is left over by %s, when the booking is ahead in the tab", (type) => {
    loaded(1_100_000, type);
    history([FORM, BOOKING], 0);
    expect(isLeftOver(ACTION)).toBe(true);
  });

  it.each(["back_forward", "reload"])("is live by %s, when nothing ahead is a booking", (type) => {
    loaded(1_100_000, type);
    history([BOOKING, FORM, OTHER_FORM], 1);
    expect(isLeftOver(ACTION)).toBe(false);
    vi.stubGlobal("window", {}); // the browser can't say
    expect(isLeftOver(ACTION)).toBe(false);
  });

  it("is live when a link, or Make another booking, led to it, whatever is ahead", () => {
    history([FORM, BOOKING], 0);
    expect(isLeftOver(ACTION)).toBe(false);
    expect(() => forgetBooked(ACTION)).not.toThrow();
  });
});

describe("a booking form restored whole by Back, from bfcache (#134)", () => {
  /** The page as it loaded, then the browser showing it again from bfcache, or not. */
  async function shown(persisted: boolean) {
    vi.resetModules();
    const page = await import("./just-booked");
    const target = new EventTarget();
    vi.stubGlobal("window", Object.assign(target, "navigation" in window ? { navigation: window.navigation } : {}));
    const changed = vi.fn();
    const stop = page.subscribe(changed);
    target.dispatchEvent(Object.assign(new Event("pageshow"), { persisted }));
    expect(changed).toHaveBeenCalledTimes(1);
    stop();
    return page.isLeftOver(ACTION);
  }
  beforeEach(() => vi.stubGlobal("window", {}));

  it("is left over though a link led to it after the booking, as when the server sends it again", async () => {
    rememberBooked(ACTION);
    loaded(1_100_000, "navigate");
    expect(await shown(true)).toBe(true);
  });

  it("is left over when it was loaded before the booking", async () => {
    rememberBooked(ACTION);
    expect(await shown(true)).toBe(true);
  });

  it("is live with nothing booked, or once the guest asks for another booking", async () => {
    expect(await shown(true)).toBe(false);
    rememberBooked(ACTION);
    forgetBooked(ACTION);
    expect(await shown(true)).toBe(false);
  });

  it("is still live on its first showing, reached by a link", async () => {
    rememberBooked(ACTION);
    loaded(1_100_000, "navigate");
    expect(await shown(false)).toBe(false);
  });

  it("with storage blocked too, is left over when the booking is ahead", async () => {
    vi.stubGlobal("sessionStorage", { getItem() { throw new Error("blocked"); } });
    history([OTHER_FORM, FORM, BOOKING], 0);
    expect(await shown(true)).toBe(true);
    history([BOOKING, FORM], 1);
    expect(await shown(true)).toBe(false);
  });
});
