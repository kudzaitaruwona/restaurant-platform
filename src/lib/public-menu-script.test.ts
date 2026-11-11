import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { ORDER_SCRIPT } from "./public-menu";

/**
 * The table page's inline script (spec 06), run as the browser would run it, on
 * just enough of a page: a small fake DOM with the elements it looks up, fetch,
 * localStorage and a timer to tick by hand. Its remembered name (landed in #69,
 * proposed, S-40), the cart, the notes, and the order tracker's polling (#70).
 * Its messages each have a place of their own on the page (S-41).
 */

class FakeElement {
  tagName = "";
  className = "";
  hidden = false;
  value = "";
  type = "";
  disabled = false;
  maxLength = 0;
  placeholder = "";
  dataset: Record<string, string> = {};
  /** The menu row an Add button sits in. */
  row?: FakeElement;
  attributes: Record<string, string> = {};
  children: FakeElement[] = [];
  private text = "";
  private listeners = new Map<string, (event: unknown) => unknown>();
  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join("");
  }
  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }
  appendChild(child: FakeElement) {
    this.children.push(child);
    return child;
  }
  append(...children: FakeElement[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: FakeElement[]) {
    this.text = "";
    this.children = children;
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  addEventListener(type: string, listener: (event: unknown) => unknown) {
    this.listeners.set(type, listener);
  }
  dispatch(type: string, event: Record<string, unknown> = {}) {
    return this.listeners.get(type)?.({ target: this, preventDefault() {}, ...event });
  }
  focusCount = 0;
  focus() {
    this.focusCount += 1;
  }
  closest(selector: string) {
    if (selector === "li") return this.row ?? null;
    return selector === "button[data-item]" && this.dataset.item ? this : null;
  }
  querySelector(selector: string) {
    return this.find((element) => `.${element.className}` === selector)[0] ?? null;
  }
  /** Every element below this one, this one included, that a test asks for. */
  find(match: (element: FakeElement) => boolean): FakeElement[] {
    return [this, ...this.children.flatMap((child) => child.find(match))].filter(match);
  }
}

type Feed = { session: string | null; items: Record<string, unknown>[] };
type Reply = { status: number; json: unknown };

/** One page load: a fresh page over the same phone's storage. */
async function loadPage(
  storage: Map<string, string>,
  sessionId: string,
  { feed = { session: sessionId, items: [] } as Feed } = {},
) {
  const state = {
    feed,
    sessionId,
    orderReply: undefined as Reply | undefined,
    waiterReply: undefined as Reply | undefined,
    requests: [] as { path: string; method: string; body?: URLSearchParams; signal?: unknown }[],
    /** While true, a tracker poll waits for its answer until `answer()` is called. */
    holdPolls: false,
    held: [] as (() => void)[],
    /** The timeouts the script asked AbortSignal for, in milliseconds. */
    timeouts: [] as number[],
  };
  const names = ["name", "place"] as const;
  const fields = Object.fromEntries(names.map((name) => [name, new FakeElement()])) as Record<
    (typeof names)[number],
    FakeElement
  >;
  const form = Object.assign(new FakeElement(), { elements: fields, hidden: true });
  const elements: Record<string, FakeElement> = {
    order: form,
    "order-error": new FakeElement(),
    "order-cancel": new FakeElement(),
    "order-scrim": new FakeElement(),
    "cart-open": Object.assign(new FakeElement(), { hidden: true }),
    "cart-count": new FakeElement(),
    "cart-items": new FakeElement(),
    cart: new FakeElement(),
    tracker: Object.assign(new FakeElement(), { hidden: true }),
    "tracker-confirm": new FakeElement(),
    "tracker-state": new FakeElement(),
    "tracker-list": new FakeElement(),
    "call-waiter": Object.assign(new FakeElement(), { hidden: true }),
    "waiter-status": new FakeElement(),
  };
  const document = Object.assign(new FakeElement(), {
    hidden: false,
    getElementById: (id: string) => elements[id],
    querySelectorAll: (selector: string) => (selector === "button[data-item]" ? addButtons : []),
    createElement: (tag: string) => Object.assign(new FakeElement(), { tagName: tag }),
  });
  const addButtons: FakeElement[] = [];
  const addButton = (id: string, name: string, price = "$8.00") => {
    const left = Object.assign(new FakeElement(), { tagName: "div", className: "left" });
    const row = Object.assign(new FakeElement(), { tagName: "li", children: [left] });
    const button = Object.assign(new FakeElement(), {
      tagName: "button",
      hidden: true,
      dataset: { item: id, name, price },
      row,
    });
    addButtons.push(button);
    return button;
  };
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, String(value)),
  };
  const fetch = async (
    url: string,
    init: { method?: string; body?: URLSearchParams; signal?: unknown } = {},
  ) => {
    const path = url.replace("/api/t/some-token", "");
    state.requests.push({ path, method: init.method ?? "GET", body: init.body, signal: init.signal });
    if (path === "/session") {
      return { ok: true, status: 200, json: async () => ({ session: state.sessionId }) };
    }
    if (path === "/waiter") {
      const reply = state.waiterReply ?? {
        status: 200,
        json: { session: state.sessionId, requestedAt: "2026-01-01T10:00:00.000Z" },
      };
      return { ok: reply.status < 400, status: reply.status, json: async () => reply.json };
    }
    if (path === "/tracker") {
      // The feed as it is when the poll was asked, not when it answers.
      const feed = state.feed;
      if (state.holdPolls) await new Promise<void>((resolve) => state.held.push(resolve));
      return { ok: true, status: 200, json: async () => feed };
    }
    const reply = state.orderReply ?? {
      status: 201,
      json: {
        placed: {
          lines: (init.body?.getAll("item") ?? []).map((_, index) => ({
            name: `Dish ${index + 1}`,
            quantity: Number(init.body?.getAll("quantity")[index]),
          })),
        },
      },
    };
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.json };
  };
  let timer: (() => unknown) | undefined;
  const stew = addButton("item-stew", "Beef stew");
  const rice = addButton("item-rice", "Rice", "$3.00");

  runInNewContext(ORDER_SCRIPT, {
    document,
    localStorage,
    fetch,
    URLSearchParams,
    Element: FakeElement,
    AbortSignal: {
      timeout: (ms: number) => {
        state.timeouts.push(ms);
        return { timeoutMs: ms };
      },
    },
    setInterval: (callback: () => unknown) => void (timer = callback),
    location: { pathname: "/t/some-token" },
  });
  await settle();

  const cartText = () => elements.cart.textContent;
  const buttonLabelled = (label: string, within = elements.cart) =>
    within.find((el) => el.tagName === "button" && el.textContent === label)[0];
  return {
    state,
    stew,
    rice,
    name: fields.name,
    form,
    /** Where a problem with the order shows: inside the sheet, above its buttons. */
    error: elements["order-error"],
    /** Where a placed order is confirmed: at the top of the tracker. */
    confirmation: elements["tracker-confirm"],
    open: elements["cart-open"],
    count: elements["cart-count"],
    waiter: elements["call-waiter"],
    /** Where the waiter's answer shows: under the header. */
    waiterStatus: elements["waiter-status"],
    cart: elements.cart,
    tracker: elements.tracker,
    trackerState: elements["tracker-state"],
    trackerList: elements["tracker-list"],
    cartText,
    buttonLabelled,
    /** How many times anything on the page has been given focus. */
    focusTotal: () =>
      [...Object.values(elements), ...Object.values(fields)]
        .flatMap((element) => (element instanceof FakeElement ? element.find(() => true) : []))
        .reduce((sum, element) => sum + element.focusCount, 0),
    noteInputs: () => elements.cart.find((el) => el.tagName === "input"),
    /** The quantity each cart line shows in its stepper, by name. */
    quantities: () =>
      Object.fromEntries(
        elements.cart.children.map((line) => [
          line.find((el) => el.className === "name")[0]?.textContent,
          Number(line.find((el) => el.className === "q")[0]?.textContent),
        ]),
      ),
    /** What an Add button's row says about the cart. */
    inOrder: (button: FakeElement) => button.row!.querySelector(".left")!.textContent,
    document,
    async add(button: FakeElement) {
      await document.dispatch("click", { target: button });
      await settle();
    },
    async placeAs(name: string) {
      fields.name.value = name;
      await form.dispatch("submit");
      await settle();
    },
    async tick() {
      // Not awaited: a tick that starts a poll held by holdPolls doesn't finish yet.
      void timer?.();
      await settle();
    },
    /** Lets every held poll answer. */
    async answer() {
      state.held.splice(0).forEach((resolve) => resolve());
      await settle();
      await settle();
    },
    polls: () => state.requests.filter((request) => request.path === "/tracker"),
    async orderOne(name: string) {
      await this.add(stew);
      await this.placeAs(name);
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the table page remembers the customer's name", () => {
  it("stores it for the session it was ordered in", async () => {
    const phone = new Map<string, string>();
    const page = await loadPage(phone, "session-1");

    await page.orderOne("Tariro");

    expect([...phone]).toEqual([["order-name:session-1", "Tariro"]]);
  });

  it("fills it in again when the page rejoins the same session", async () => {
    const phone = new Map<string, string>();
    await (await loadPage(phone, "session-1")).orderOne("Tariro");

    expect((await loadPage(phone, "session-1")).name.value).toBe("Tariro");
  });

  it("doesn't carry it into another session: the next party starts blank", async () => {
    const phone = new Map<string, string>();
    await (await loadPage(phone, "session-1")).orderOne("Tariro");

    expect((await loadPage(phone, "session-2")).name.value).toBe("");
  });

  it("asks again once the table's session has ended and a new one starts", async () => {
    const phone = new Map<string, string>();
    const page = await loadPage(phone, "session-1");
    await page.orderOne("Tariro");
    page.state.feed = { session: null, items: [] };
    await page.tick();
    page.state.sessionId = "session-2";

    await page.add(page.rice);

    expect(page.name.value).toBe("");
  });

  it("won't place an order with no name", async () => {
    const page = await loadPage(new Map(), "session-1");
    await page.add(page.stew);

    await page.placeAs("   ");

    expect(page.state.requests.filter((request) => request.path === "/orders")).toEqual([]);
    expect(page.error.textContent).toMatch(/name/i);
    expect(page.form.hidden).toBe(false);
  });
});

describe("the cart", () => {
  it("shows the Add buttons only once the table's session is joined", async () => {
    const page = await loadPage(new Map(), "session-1");
    expect(page.stew.hidden).toBe(false);
    expect(page.rice.hidden).toBe(false);
  });

  it("has no order bar until something is added, then counts what is in it", async () => {
    const page = await loadPage(new Map(), "session-1");
    expect(page.open.hidden).toBe(true);

    await page.add(page.stew);
    await page.add(page.stew);
    await page.add(page.rice);

    expect(page.open.hidden).toBe(false);
    expect(page.count.textContent).toBe("3");
    expect(page.open.attributes["aria-label"]).toBe("Your order, 3 items");
  });

  it("says on each item's row how many are in the order, and clears it once ordered", async () => {
    const page = await loadPage(new Map(), "session-1");
    expect(page.inOrder(page.stew)).toBe("");

    await page.add(page.stew);
    await page.add(page.stew);

    expect(page.inOrder(page.stew)).toBe("2 in your order");
    expect(page.inOrder(page.rice)).toBe("");

    await page.placeAs("Tariro");
    expect(page.inOrder(page.stew)).toBe("");
  });

  it("holds several items with their quantities, one line per item, with its price", async () => {
    const page = await loadPage(new Map(), "session-1");

    await page.add(page.stew);
    await page.add(page.stew);
    await page.add(page.rice);

    expect(page.cart.children).toHaveLength(2);
    expect(page.quantities()).toEqual({ "Beef stew": 2, Rice: 1 });
    expect(page.cartText()).toContain("$8.00 each");
    expect(page.cartText()).toContain("$3.00");
  });

  it("changes quantities, and drops a line that reaches none", async () => {
    const page = await loadPage(new Map(), "session-1");
    await page.add(page.stew);

    page.buttonLabelled("+")!.dispatch("click");
    page.buttonLabelled("+")!.dispatch("click");
    expect(page.quantities()).toEqual({ "Beef stew": 3 });

    for (let n = 0; n < 3; n++) page.buttonLabelled("−")?.dispatch("click");
    expect(page.cart.children).toHaveLength(0);
    expect(page.open.hidden).toBe(true);
  });

  it("stops at 20 of an item, and at 20 different items", async () => {
    const page = await loadPage(new Map(), "session-1");
    await page.add(page.stew);
    for (let n = 0; n < 25; n++) page.buttonLabelled("+")?.dispatch("click");
    expect(page.quantities()).toEqual({ "Beef stew": 20 });

    const many = Array.from({ length: 25 }, (_, n) => {
      const button = Object.assign(new FakeElement(), {
        tagName: "button",
        dataset: { item: `item-${n}`, name: `Dish ${n}`, price: "" },
      });
      return button;
    });
    for (const button of many) await page.add(button);

    expect(page.cart.children).toHaveLength(20);
    expect(page.error.textContent).toMatch(/20/);
    expect(page.form.hidden).toBe(false);
  });

  it("removes a line", async () => {
    const page = await loadPage(new Map(), "session-1");
    await page.add(page.stew);
    await page.add(page.rice);

    page.buttonLabelled("Remove")!.dispatch("click");

    expect(page.cart.children).toHaveLength(1);
  });

  it("opens from the order bar and closes again", async () => {
    const page = await loadPage(new Map(), "session-1");
    await page.add(page.stew);
    expect(page.form.hidden).toBe(true);

    page.open.dispatch("click");
    expect(page.form.hidden).toBe(false);
    page.document.getElementById("order-cancel").dispatch("click");
    expect(page.form.hidden).toBe(true);

    page.open.dispatch("click");
    page.document.getElementById("order-scrim").dispatch("click");
    expect(page.form.hidden).toBe(true);
  });

  it("moves focus into the sheet when it opens and back to the order bar when it closes", async () => {
    const page = await loadPage(new Map(), "session-1");
    await page.add(page.stew);
    const before = page.focusTotal();

    page.open.dispatch("click");
    expect(page.focusTotal()).toBe(before + 1);
    expect(page.open.focusCount).toBe(0);

    page.document.getElementById("order-cancel").dispatch("click");
    expect(page.open.focusCount).toBe(1);
  });
});

describe("placing the order", () => {
  it("posts every line with its quantity and note, as one order, with the name and session", async () => {
    const page = await loadPage(new Map(), "session-1");
    await page.add(page.stew);
    await page.add(page.stew);
    await page.add(page.rice);
    const [stewNote, riceNote] = page.noteInputs();
    stewNote.value = "no onions";
    stewNote.dispatch("input");
    expect(riceNote.maxLength).toBe(200);

    await page.placeAs("Tariro");

    const orders = page.state.requests.filter((request) => request.path === "/orders");
    expect(orders).toHaveLength(1);
    const body = orders[0].body!;
    expect(orders[0].method).toBe("POST");
    expect(body.getAll("item")).toEqual(["item-stew", "item-rice"]);
    expect(body.getAll("quantity")).toEqual(["2", "1"]);
    expect(body.getAll("note")).toEqual(["no onions", ""]);
    expect(body.get("name")).toBe("Tariro");
    expect(body.get("session")).toBe("session-1");
  });

  it("sends nothing that says what anything costs", async () => {
    const page = await loadPage(new Map(), "session-1");
    await page.add(page.stew);

    await page.placeAs("Tariro");

    const body = page.state.requests.find((request) => request.path === "/orders")!.body!;
    expect([...new Set(body.keys())].sort()).toEqual(["item", "name", "note", "quantity", "session"]);
  });

  it("empties the cart, closes it, and confirms at the top of the tracker that there is nothing to pay on the page", async () => {
    const page = await loadPage(new Map(), "session-1");
    await page.add(page.stew);
    await page.add(page.rice);
    page.open.dispatch("click");

    await page.placeAs("Tariro");

    expect(page.cart.children).toHaveLength(0);
    expect(page.open.hidden).toBe(true);
    expect(page.form.hidden).toBe(true);
    expect(page.confirmation.textContent).toContain("1 × Dish 1, 1 × Dish 2");
    expect(page.confirmation.textContent).toContain("Pay at the table with your waiter as usual");
    expect(page.tracker.hidden).toBe(false);
    expect(page.error.textContent).toBe("");

    await page.add(page.rice);
    expect(page.confirmation.textContent).toBe("");
  });

  it("keeps the cart when the order doesn't go through", async () => {
    const page = await loadPage(new Map(), "session-1");
    await page.add(page.stew);
    page.state.orderReply = { status: 429, json: { error: "That's a lot of orders at once." } };

    await page.placeAs("Tariro");

    expect(page.cart.children).toHaveLength(1);
    expect(page.error.textContent).toBe("That's a lot of orders at once.");
    expect(page.form.hidden).toBe(false);
    expect(page.confirmation.textContent).toBe("");
  });

  it("takes out an item that is no longer available, and keeps the rest", async () => {
    const page = await loadPage(new Map(), "session-1");
    await page.add(page.stew);
    await page.add(page.rice);
    page.state.orderReply = {
      status: 409,
      json: { error: "Sorry, that item isn't available right now.", code: "unavailable", item: "item-rice" },
    };

    await page.placeAs("Tariro");

    expect(page.cartText()).toContain("Beef stew");
    expect(page.cartText()).not.toContain("Rice");
    expect(page.error.textContent).toContain("isn't available");
  });

  it("doesn't reopen an empty sheet when the only item is no longer available, and says so on the page", async () => {
    const page = await loadPage(new Map(), "session-1");
    await page.add(page.stew);
    page.state.orderReply = {
      status: 409,
      json: { error: "Sorry, that item isn't available right now.", code: "unavailable", item: "item-stew" },
    };

    await page.placeAs("Tariro");

    expect(page.cart.children).toHaveLength(0);
    expect(page.form.hidden).toBe(true);
    expect(page.document.getElementById("waiter-status").textContent).toContain("isn't available");
  });

  it("rejoins the table's session when the order says it has changed", async () => {
    const page = await loadPage(new Map(), "session-1");
    await page.add(page.stew);
    page.state.sessionId = "session-2";
    page.state.orderReply = { status: 409, json: { error: "reset", code: "session_changed" } };

    await page.placeAs("Tariro");
    page.state.orderReply = undefined;
    await page.placeAs("Tariro");

    const orders = page.state.requests.filter((request) => request.path === "/orders");
    expect(orders.map((request) => request.body!.get("session"))).toEqual(["session-1", "session-2"]);
  });
});

describe("the order tracker", () => {
  const item = (extra: Record<string, unknown> = {}) => ({
    quantity: 2,
    name: "Beef stew",
    note: "no onions",
    customer: "Tariro",
    status: "placed",
    time: "19:42",
    ...extra,
  });

  it("is hidden while nobody at the table has ordered", async () => {
    const page = await loadPage(new Map(), "session-1");
    expect(page.tracker.hidden).toBe(true);
  });

  it("lists everything in the session on load, with quantity, name, note, who and when", async () => {
    const feed = { session: "session-1", items: [item(), item({ quantity: 1, name: "Rice", note: null, customer: "Farai" })] };

    const page = await loadPage(new Map(), "session-1", { feed });

    expect(page.tracker.hidden).toBe(false);
    expect(page.trackerList.children).toHaveLength(2);
    const text = page.trackerList.textContent;
    expect(text).toContain("2 × Beef stew");
    expect(text).toContain("no onions");
    expect(text).toContain("Tariro");
    expect(text).toContain("19:42");
    expect(text).toContain("Ordered");
    expect(text).toContain("1 × Rice");
    expect(text).toContain("Farai");
  });

  it("polls an uncached endpoint every 5 seconds and shows what changed, without a reload", async () => {
    const page = await loadPage(new Map(), "session-1", { feed: { session: "session-1", items: [item()] } });

    page.state.feed = { session: "session-1", items: [item({ status: "cooking" }), item({ name: "Rice", customer: "Farai" })] };
    await page.tick();

    expect(page.trackerList.children).toHaveLength(2);
    expect(page.trackerList.textContent).toContain("Cooking");
    const polls = page.state.requests.filter((request) => request.path === "/tracker");
    expect(polls.length).toBeGreaterThanOrEqual(2);
    expect(polls.every((request) => request.method === "GET" && request.body === undefined)).toBe(true);
  });

  it("shows a voided item as voided", async () => {
    const page = await loadPage(new Map(), "session-1", {
      feed: { session: "session-1", items: [item({ status: "voided" })] },
    });

    const row = page.trackerList.children[0];
    expect(row.textContent).toContain("Voided");
    expect(row.className).toContain("voided");
  });

  it("shows the other statuses in plain words", async () => {
    const statuses = ["placed", "cooking", "done", "delivered"];
    const page = await loadPage(new Map(), "session-1", {
      feed: { session: "session-1", items: statuses.map((status) => item({ status })) },
    });

    expect(page.trackerList.children.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Ordered"),
      expect.stringContaining("Cooking"),
      expect.stringContaining("Ready"),
      expect.stringContaining("Served"),
    ]);
    expect(page.trackerList.children.map((row) => row.children[1].className)).toEqual([
      "pill pill-placed",
      "pill pill-cooking",
      "pill pill-done",
      "pill pill-served ico",
    ]);
  });

  it("doesn't poll while the page is hidden", async () => {
    const page = await loadPage(new Map(), "session-1");
    const before = page.state.requests.length;
    page.document.hidden = true;

    await page.tick();

    expect(page.state.requests).toHaveLength(before);
  });

  it("polls again at once when the page comes back", async () => {
    const page = await loadPage(new Map(), "session-1");
    const before = page.state.requests.length;

    await page.document.dispatch("visibilitychange");
    await settle();

    expect(page.state.requests.length).toBe(before + 1);
  });

  it("puts what customers typed on the page as text, never as markup", async () => {
    const hostile = `<img src=x onerror="alert(1)">`;
    const page = await loadPage(new Map(), "session-1", {
      feed: { session: "session-1", items: [item({ customer: hostile, note: hostile, name: hostile })] },
    });

    expect(page.trackerList.textContent).toContain(hostile);
    expect(ORDER_SCRIPT).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  it("says the session has ended once it closes, and the next Add starts a fresh one", async () => {
    const page = await loadPage(new Map(), "session-1", { feed: { session: "session-1", items: [item()] } });

    page.state.feed = { session: null, items: [] };
    await page.tick();

    expect(page.trackerList.children).toHaveLength(0);
    expect(page.tracker.hidden).toBe(false);
    expect(page.trackerState.textContent).toMatch(/ended/i);

    page.state.sessionId = "session-2";
    page.state.feed = { session: "session-2", items: [] };
    const joins = () => page.state.requests.filter((request) => request.path === "/session").length;
    const before = joins();
    await page.add(page.rice);

    expect(joins()).toBe(before + 1);
    expect(page.trackerState.textContent).toBe("");
    expect(page.tracker.hidden).toBe(true);
  });

  it("treats another party's session as the end of its own", async () => {
    const page = await loadPage(new Map(), "session-1", { feed: { session: "session-1", items: [item()] } });

    page.state.feed = { session: "session-2", items: [item({ customer: "Strangers" })] };
    await page.tick();

    expect(page.trackerList.textContent).not.toContain("Strangers");
    expect(page.trackerState.textContent).toMatch(/ended/i);
  });

  it("polls right after an order is placed", async () => {
    const page = await loadPage(new Map(), "session-1");
    await page.add(page.stew);
    const before = page.state.requests.filter((request) => request.path === "/tracker").length;

    page.state.feed = { session: "session-1", items: [item({ customer: "Tariro" })] };
    await page.placeAs("Tariro");

    expect(page.state.requests.filter((request) => request.path === "/tracker").length).toBeGreaterThan(before);
    expect(page.trackerList.textContent).toContain("Tariro");
  });

  it("skips a tick while a poll is still waiting for its answer, so polls don't pile up on a slow line", async () => {
    const page = await loadPage(new Map(), "session-1");
    page.state.holdPolls = true;

    await page.tick();
    const before = page.polls().length;
    await page.tick();
    await page.tick();
    expect(page.polls()).toHaveLength(before);

    page.state.holdPolls = false;
    await page.answer();
    await page.tick();
    expect(page.polls()).toHaveLength(before + 1);
  });

  it("gives up on a poll after 4 seconds", async () => {
    const page = await loadPage(new Map(), "session-1");

    expect(page.state.timeouts).toContain(4000);
    expect(page.polls().every((request) => request.signal !== undefined)).toBe(true);
  });

  it("never lets an older answer overwrite a newer one: an order placed during a poll polls again after it", async () => {
    const page = await loadPage(new Map(), "session-1");
    await page.add(page.stew);
    page.state.holdPolls = true;
    await page.tick();

    page.state.feed = { session: "session-1", items: [item({ customer: "Tariro" })] };
    page.state.holdPolls = false;
    await page.placeAs("Tariro");
    await page.answer();

    expect(page.trackerList.textContent).toContain("Tariro");
  });
});

describe("Call a waiter", () => {
  const waiterCalls = (page: Awaited<ReturnType<typeof loadPage>>) =>
    page.state.requests.filter((request) => request.path === "/waiter");

  it("shows the link only once the table's session is joined, like the Add buttons", async () => {
    const page = await loadPage(new Map(), "session-1");
    expect(page.waiter.hidden).toBe(false);
  });

  it("posts to the table's waiter endpoint, with no body, and confirms on the page", async () => {
    const page = await loadPage(new Map(), "session-1");

    await page.waiter.dispatch("click");
    await settle();

    expect(waiterCalls(page)).toEqual([expect.objectContaining({ method: "POST", body: undefined })]);
    expect(page.waiterStatus.textContent).toMatch(/waiter/i);
    expect(page.waiterStatus.textContent).toMatch(/on (their|the) way|coming/i);
    expect(page.waiter.dataset).toHaveProperty("called");
  });

  it("says so when it didn't go through, and can be tried again", async () => {
    const page = await loadPage(new Map(), "session-1");
    page.state.waiterReply = { status: 404, json: { error: "This code is out of date." } };

    await page.waiter.dispatch("click");
    await settle();
    expect(page.waiterStatus.textContent).toMatch(/didn't go through/i);
    expect(page.waiterStatus.dataset.tone).toBe("error");

    page.state.waiterReply = undefined;
    await page.waiter.dispatch("click");
    await settle();
    expect(page.waiterStatus.textContent).toMatch(/on (their|the) way|coming/i);
    expect(page.waiterStatus.dataset.tone).toBeUndefined();
  });

  it("is one call at a time: a second tap while the first is in flight sends nothing", async () => {
    const page = await loadPage(new Map(), "session-1");

    const first = page.waiter.dispatch("click");
    const second = page.waiter.dispatch("click");
    await Promise.all([first, second]);
    await settle();

    expect(waiterCalls(page)).toHaveLength(1);
    expect(page.waiter.disabled).toBe(false);
  });

  it("joins the fresh session the call opened when the table's last one had ended", async () => {
    const phone = new Map<string, string>();
    const page = await loadPage(phone, "session-1");
    await page.orderOne("Tariro");
    page.state.feed = { session: null, items: [] };
    await page.tick();
    page.state.waiterReply = { status: 200, json: { session: "session-2", requestedAt: "x" } };
    page.state.sessionId = "session-2";
    page.state.feed = { session: "session-2", items: [] };

    await page.waiter.dispatch("click");
    await settle();

    expect(page.name.value).toBe("");
    await page.orderOne("Rudo");
    const orders = page.state.requests.filter((request) => request.path === "/orders");
    expect(orders.at(-1)?.body?.get("session")).toBe("session-2");
  });

  it("puts the confirmation on the page as text, never markup", async () => {
    const page = await loadPage(new Map(), "session-1");
    await page.waiter.dispatch("click");
    await settle();
    expect(page.waiterStatus.children).toEqual([]);
  });
});
