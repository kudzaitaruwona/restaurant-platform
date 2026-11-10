import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { ORDER_SCRIPT } from "./public-menu";

/**
 * The table page's inline script (spec 06), run as the browser would run it, on
 * just enough of a page: the elements it looks up, fetch and localStorage. Its
 * remembered name (landed in #69 from #70, proposed, S-40): the name a customer
 * ordered under fills in again on that phone in the same session, and not in the
 * next party's.
 */

class FakeElement {
  hidden = false;
  textContent = "";
  value = "";
  disabled = false;
  dataset: Record<string, string> = {};
  private listeners = new Map<string, (event: unknown) => unknown>();
  addEventListener(type: string, listener: (event: unknown) => unknown) {
    this.listeners.set(type, listener);
  }
  dispatch(type: string, event: unknown = {}) {
    return this.listeners.get(type)?.(event);
  }
  closest() {
    return null;
  }
}

type Fields = Record<"item" | "quantity" | "note" | "name" | "place", FakeElement>;

/** One page load: a fresh page over the same phone's storage. */
async function loadPage(storage: Map<string, string>, sessionId: string) {
  const fields: Fields = {
    item: new FakeElement(),
    quantity: Object.assign(new FakeElement(), { value: "1" }),
    note: new FakeElement(),
    name: new FakeElement(),
    place: new FakeElement(),
  };
  const form = Object.assign(new FakeElement(), { elements: fields, hidden: true });
  const elements: Record<string, FakeElement> = {
    order: form,
    "order-status": new FakeElement(),
    "order-item": new FakeElement(),
    "order-cancel": new FakeElement(),
  };
  const document = Object.assign(new FakeElement(), {
    getElementById: (id: string) => elements[id],
    querySelectorAll: () => [],
  });
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, String(value)),
  };
  const fetch = async (url: string) => {
    const json = url.endsWith("/session")
      ? { session: sessionId }
      : { placed: { quantity: 1, name: "Stew" } };
    return { ok: true, status: url.endsWith("/session") ? 200 : 201, json: async () => json };
  };
  class FormData {
    constructor(private form: { elements: Fields }) {}
    *[Symbol.iterator]() {
      for (const key of ["item", "quantity", "note", "name"] as const) {
        yield [key, this.form.elements[key].value];
      }
    }
  }

  runInNewContext(ORDER_SCRIPT, {
    document,
    localStorage,
    fetch,
    FormData,
    URLSearchParams,
    Element: FakeElement,
    location: { pathname: "/t/some-token" },
  });
  await settle();

  return {
    name: fields.name,
    async placeOrderAs(name: string) {
      fields.item.value = "item-1";
      fields.name.value = name;
      await form.dispatch("submit", { preventDefault() {} });
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the table page remembers the customer's name", () => {
  it("stores it for the session it was ordered in", async () => {
    const phone = new Map<string, string>();
    const page = await loadPage(phone, "session-1");

    await page.placeOrderAs("Tariro");

    expect([...phone]).toEqual([["order-name:session-1", "Tariro"]]);
  });

  it("fills it in again when the page rejoins the same session", async () => {
    const phone = new Map<string, string>();
    await (await loadPage(phone, "session-1")).placeOrderAs("Tariro");

    const reopened = await loadPage(phone, "session-1");

    expect(reopened.name.value).toBe("Tariro");
  });

  it("doesn't carry it into another session: the next party starts blank", async () => {
    const phone = new Map<string, string>();
    await (await loadPage(phone, "session-1")).placeOrderAs("Tariro");

    const nextParty = await loadPage(phone, "session-2");

    expect(nextParty.name.value).toBe("");
  });
});
