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
  scrolledTo = 0;
  scrollIntoView() {
    this.scrolledTo += 1;
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

type Feed = { session: string | null; items: Record<string, unknown>[]; waiter?: boolean };
type Reply = { status: number; json: unknown; headers?: Record<string, string> };

/** One page load: a fresh page over the same phone's storage. */
async function loadPage(
  storage: Map<string, string>,
  sessionId: string,
  {
    feed = { session: sessionId, items: [] } as Feed,
    joinReplies = [] as (Reply | "abort" | "hang")[],
  } = {},
) {
  const state = {
    feed,
    sessionId,
    orderReply: undefined as Reply | undefined,
    /** While true, an order is sent and no answer comes back. */
    loseOrderReply: false,
    waiterReply: undefined as Reply | undefined,
    /** Answers to the next scans, in turn: a reply, "abort" for one that fails, or "hang" for one that never answers. */
    joinReplies,
    /** Answers each scan that hung, late. */
    hung: [] as ((reply: unknown) => void)[],
    /** Timeouts the script set, by delay in milliseconds, until they run. */
    later: [] as { ms: number; run: () => void }[],
    requests: [] as { path: string; method: string; body?: URLSearchParams; signal?: unknown }[],
    /** While true, a tracker poll waits for its answer until `answer()` is called. */
    holdPolls: false,
    held: [] as (() => void)[],
    /** While true, a waiter call is answered only by `answerCall()`. */
    holdWaiter: false,
    heldWaiter: [] as (() => void)[],
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
      const next = state.joinReplies.shift();
      if (next === "abort") throw new TypeError("Failed to fetch");
      // As on a phone without AbortSignal.timeout: the fetch itself is never given up.
      if (next === "hang") return new Promise((resolve) => state.hung.push(resolve));
      if (next) {
        return {
          ok: next.status < 400,
          status: next.status,
          headers: { get: (name: string) => next.headers?.[name] ?? null },
          json: async () => next.json,
        };
      }
      return { ok: true, status: 200, json: async () => ({ session: state.sessionId }) };
    }
    if (path === "/waiter") {
      const reply = state.waiterReply ?? {
        status: 200,
        json: { session: state.sessionId, requestedAt: "2026-01-01T10:00:00.000Z" },
      };
      // As the server does: the table's feed shows the call from now on.
      if (reply.status < 400) state.feed = { ...state.feed, waiter: true };
      // Committed, then held until the test lets its answer through.
      if (state.holdWaiter) await new Promise<void>((resolve) => state.heldWaiter.push(resolve));
      return { ok: reply.status < 400, status: reply.status, json: async () => reply.json };
    }
    if (path === "/tracker") {
      // The feed as it is when the poll was asked, not when it answers.
      const feed = state.feed;
      if (state.holdPolls) await new Promise<void>((resolve) => state.held.push(resolve));
      return { ok: true, status: 200, json: async () => feed };
    }
    if (state.loseOrderReply) throw new TypeError("Failed to fetch");
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
    crypto,
    Element: FakeElement,
    AbortSignal: {
      timeout: (ms: number) => {
        state.timeouts.push(ms);
        return { timeoutMs: ms };
      },
    },
    setTimeout: (run: () => void, ms: number) => {
      const entry = { ms, run };
      state.later.push(entry);
      return entry;
    },
    clearTimeout: (entry: unknown) => {
      const at = state.later.indexOf(entry as (typeof state.later)[number]);
      if (at >= 0) state.later.splice(at, 1);
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
    async answerCall() {
      state.heldWaiter.splice(0).forEach((resolve) => resolve());
      await settle();
      await settle();
    },
    /** Runs the oldest retry the script has waiting. */
    async retryNow() {
      state.later.shift()?.run();
      await settle();
    },
    joins: () => state.requests.filter((request) => request.path === "/session").length,
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

describe("a first scan that fails (#98)", () => {
  const down = "abort" as const;

  it("says so, retries by itself with growing waits, and orders once it works, without a reload", async () => {
    const failing = await loadPage(new Map(), "session-1", { joinReplies: [down, down, down] });
    expect(failing.stew.hidden).toBe(true);
    expect(failing.waiterStatus.textContent).toMatch(/trying again/i);
    expect(failing.waiter.hidden).toBe(true);
    expect(failing.state.later.map((entry) => entry.ms)).toEqual([2000]);

    await failing.retryNow();
    expect(failing.state.later.map((entry) => entry.ms)).toEqual([5000]);
    await failing.retryNow();
    expect(failing.state.later.map((entry) => entry.ms)).toEqual([10000]);
    await failing.retryNow();

    expect(failing.joins()).toBe(4);
    expect(failing.stew.hidden).toBe(false);
    expect(failing.waiter.hidden).toBe(false);
    expect(failing.waiterStatus.textContent).toBe("");
  });

  it("stops after five retries and leaves a message with a manual retry", async () => {
    const page = await loadPage(new Map(), "session-1", { joinReplies: Array(6).fill(down) });
    for (let i = 0; i < 5; i++) await page.retryNow();

    expect(page.joins()).toBe(6);
    expect(page.state.later).toEqual([]);
    expect(page.waiterStatus.textContent).toMatch(/isn't available/i);
    expect(page.stew.hidden).toBe(true);
  });

  it("joins at once when Try again is pressed, and then shows ordering", async () => {
    const page = await loadPage(new Map(), "session-1", { joinReplies: Array(6).fill(down) });
    for (let i = 0; i < 5; i++) await page.retryNow();
    const button = page.waiterStatus.find((el) => el.tagName === "button")[0];

    await button.dispatch("click");
    await settle();

    expect(page.joins()).toBe(7);
    expect(page.stew.hidden).toBe(false);
    expect(page.waiterStatus.textContent).toBe("");
  });

  it("a manual retry during the wait replaces the timer rather than doubling the joins", async () => {
    const page = await loadPage(new Map(), "session-1", { joinReplies: [down] });
    const button = page.waiterStatus.find((el) => el.tagName === "button")[0];

    await button.dispatch("click");
    await settle();

    expect(page.joins()).toBe(2);
    expect(page.state.later).toEqual([]);
    expect(page.stew.hidden).toBe(false);
  });

  it("retries a 5xx, and waits at least as long as a 429's Retry-After", async () => {
    const page = await loadPage(new Map(), "session-1", {
      joinReplies: [{ status: 503, json: {} }, { status: 429, json: {}, headers: { "retry-after": "30" } }],
    });
    expect(page.state.later.map((entry) => entry.ms)).toEqual([2000]);
    await page.retryNow();
    expect(page.state.later.map((entry) => entry.ms)).toEqual([30000]);
    await page.retryNow();
    expect(page.stew.hidden).toBe(false);
  });

  it("doesn't retry a refusal that won't change: a code that no longer works is the plain menu", async () => {
    for (const status of [404, 403, 400]) {
      const page = await loadPage(new Map(), "session-1", { joinReplies: [{ status, json: {} }] });
      expect(page.joins()).toBe(1);
      expect(page.state.later).toEqual([]);
      expect(page.waiterStatus.textContent).toBe("");
      expect(page.stew.hidden).toBe(true);
    }
  });
});

describe("a scan that never answers (#98)", () => {
  const late = (session: string) => ({ ok: true, status: 200, json: async () => ({ session }) });

  it("is given up after 8 seconds and retried, and its late answer changes nothing", async () => {
    const page = await loadPage(new Map(), "session-2", { joinReplies: ["hang"] });
    expect(page.state.timeouts).toEqual([8000]);
    expect(page.state.later.map((entry) => entry.ms)).toEqual([8000]);
    expect(page.waiterStatus.textContent).toBe("");

    await page.retryNow(); // the 8 seconds pass
    expect(page.waiterStatus.textContent).toMatch(/trying again/i);
    expect(page.state.later.map((entry) => entry.ms)).toEqual([2000]);

    await page.retryNow();
    expect(page.stew.hidden).toBe(false);
    expect(page.waiterStatus.textContent).toBe("");
    expect(page.state.later).toEqual([]);

    const polls = page.polls().length;
    page.state.hung[0](late("session-1"));
    await settle();
    expect(page.polls()).toHaveLength(polls);
    await page.add(page.stew);
    await page.placeAs("Ada");
    expect(page.state.requests.find((request) => request.path === "/orders")!.body!.get("session")).toBe("session-2");
  });

  it("leaves the message and Try again up, and frees the button, if an answer arrives after it was given up", async () => {
    const page = await loadPage(new Map(), "session-1", { joinReplies: ["hang"] });
    await page.retryNow();
    page.state.hung[0](late("session-1"));
    await settle();

    expect(page.stew.hidden).toBe(true);
    await page.waiterStatus.find((el) => el.tagName === "button")[0].dispatch("click");
    await settle();
    expect(page.joins()).toBe(2);
    expect(page.stew.hidden).toBe(false);
  });

  it("gives Place order back, with the cart and a message", async () => {
    const page = await loadPage(new Map(), "session-1");
    await page.add(page.stew);
    page.state.feed = { session: null, items: [] };
    await page.tick();
    page.state.joinReplies.push("hang");
    page.name.value = "Ada";
    void page.form.dispatch("submit");
    await settle();
    expect(page.form.elements.place.disabled).toBe(true);

    await page.retryNow(); // the 8 seconds pass
    expect(page.form.elements.place.disabled).toBe(false);
    expect(page.error.textContent).toMatch(/didn't go through/);
    expect(page.cart.children).toHaveLength(1);
  });

  it("leaves an Add in the cart when its join hangs", async () => {
    const page = await loadPage(new Map(), "session-1");
    page.state.feed = { session: null, items: [] };
    await page.tick();
    page.state.joinReplies.push("hang");
    void page.document.dispatch("click", { target: page.stew });
    await settle();
    await page.retryNow();
    expect(page.cart.children).toHaveLength(1);
    expect(page.state.later).toEqual([]);
  });
});

describe("Try again and the keyboard (#98)", () => {
  it("is never disabled, replaced or moved while the retries run", async () => {
    const page = await loadPage(new Map(), "session-1", { joinReplies: [...Array(6).fill("abort"), "hang"] });
    const placed = page.waiterStatus.children;
    const button = page.waiterStatus.find((el) => el.tagName === "button")[0];
    for (let i = 0; i < 5; i++) {
      await page.retryNow();
      expect(page.waiterStatus.children).toBe(placed);
      expect(button.disabled).toBe(false);
    }
    expect(page.waiterStatus.textContent).toMatch(/isn't available/i);

    // A second press while one is being tried asks nothing more.
    await button.dispatch("click");
    await button.dispatch("click");
    await settle();
    expect(page.joins()).toBe(7);
    expect(button.disabled).toBe(false);
  });
});

describe("a first scan that fails, then #85's rules (#98 with #85)", () => {
  it("a refusal after a transient failure leaves no error tone behind", async () => {
    const page = await loadPage(new Map(), "session-1", {
      joinReplies: [{ status: 503, json: {} }, { status: 404, json: {} }],
    });
    expect(page.waiterStatus.dataset.tone).toBe("error");
    await page.retryNow();
    expect(page.waiterStatus.textContent).toBe("");
    expect(page.waiterStatus.dataset.tone).toBeUndefined();
    expect(page.state.later).toEqual([]);
  });

  it("a retried first join tags the cart to its session, so an order places without the ended-session prompt", async () => {
    const page = await loadPage(new Map(), "session-1", { joinReplies: ["abort" as const] });
    await page.retryNow();
    await page.add(page.stew);
    await page.placeAs("Ada");

    expect(page.state.requests.filter((request) => request.path === "/orders")).toHaveLength(1);
    expect(page.joins()).toBe(2);
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
    expect([...new Set(body.keys())].sort()).toEqual(["item", "name", "note", "quantity", "request", "session"]);
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
    expect(page.error.textContent).toBe("Sorry, Rice isn't available right now. It was taken out of your order.");
  });

  it("can no longer add an item that has sold out, without a reload (#87)", async () => {
    const page = await loadPage(new Map(), "session-1");
    await page.add(page.stew);
    await page.add(page.rice);
    page.state.orderReply = {
      status: 409,
      json: { error: "Sorry, that item isn't available right now.", code: "unavailable", item: "item-rice" },
    };
    await page.placeAs("Tariro");

    expect(page.rice.disabled).toBe(true);
    expect(page.rice.textContent).toBe("Sold out");
    expect(page.stew.disabled).toBe(false);
    await page.add(page.rice);
    expect(page.cartText()).not.toContain("Rice");
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
    const said = page.document.getElementById("waiter-status");
    expect(said.textContent).toBe("Sorry, Beef stew isn't available right now. It was taken out of your order.");
    // Wherever the guest had scrolled, it is brought into view (#87).
    expect(said.scrolledTo).toBe(1);
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

describe("retrying an order whose answer was lost (#84)", () => {
  const bodies = (page: Awaited<ReturnType<typeof loadPage>>) =>
    page.state.requests.filter((request) => request.path === "/orders").map((request) => request.body!);

  async function lostOrder() {
    const page = await loadPage(new Map(), "session-1");
    page.state.loseOrderReply = true;
    await page.orderOne("Tariro");
    expect(page.error.textContent).toMatch(/didn't go through/);
    page.state.loseOrderReply = false;
    return page;
  }

  it("sends the very same submission, and shows it as placed", async () => {
    const page = await lostOrder();

    await page.placeAs("Tariro");

    const [first, second] = bodies(page);
    expect(first.get("request")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(second.toString()).toBe(first.toString());
    expect(page.confirmation.textContent).toContain("1 × Dish 1");
    expect(page.cart.children).toHaveLength(0);
  });

  it.each([
    ["a server error", { status: 500, json: { error: "boom" } }],
    ["an answer cut short", { status: 201, json: {} }],
  ])("keeps the same submission after %s", async (_what, reply) => {
    const page = await loadPage(new Map(), "session-1");
    page.state.orderReply = reply;
    await page.orderOne("Tariro");
    page.state.orderReply = undefined;

    await page.placeAs("Tariro");

    const [first, second] = bodies(page);
    expect(second.get("request")).toBe(first.get("request"));
    expect(page.confirmation.textContent).toContain("1 × Dish 1");
  });

  it("is a new submission once the last one was placed: the same dish can be ordered again", async () => {
    const page = await loadPage(new Map(), "session-1");
    await page.orderOne("Tariro");
    await page.orderOne("Tariro");

    const [first, second] = bodies(page);
    expect(second.get("request")).not.toBe(first.get("request"));
  });

  it("asks the session it was sent to, even once that has ended, and keeps the confirmation", async () => {
    const page = await lostOrder();
    page.state.feed = { session: null, items: [] };
    await page.tick();
    page.state.sessionId = "session-2";

    await page.placeAs("Tariro");
    await page.tick();

    expect(bodies(page)[1].get("session")).toBe("session-1");
    expect(page.confirmation.textContent).toContain("1 × Dish 1");
    expect(page.tracker.hidden).toBe(false);
  });

  it("still asks the first session after an Add has joined the table's fresh one", async () => {
    const page = await lostOrder();
    page.state.feed = { session: null, items: [] };
    await page.tick();
    page.state.sessionId = "session-2";
    await page.add(page.rice);

    await page.placeAs("Tariro");

    expect(bodies(page)[1].get("session")).toBe("session-1");
    expect(bodies(page)[1].get("request")).toBe(bodies(page)[0].get("request"));
  });

  it("places it in the table's fresh session, as a new submission, when the first never arrived", async () => {
    const page = await lostOrder();
    page.state.sessionId = "session-2";
    page.state.orderReply = { status: 409, json: { error: "reset", code: "session_changed" } };
    await page.placeAs("Tariro");
    page.state.orderReply = undefined;
    await page.placeAs("Tariro");

    const [first, , third] = bodies(page);
    expect(third.get("session")).toBe("session-2");
    expect(third.get("request")).not.toBe(first.get("request"));
  });

  it("goes back to joining first once a refusal has answered", async () => {
    const page = await loadPage(new Map(), "session-1");
    page.state.orderReply = { status: 429, json: { error: "Wait." } };
    await page.orderOne("Tariro");
    page.state.orderReply = undefined;
    page.state.feed = { session: null, items: [] };
    await page.tick();
    page.state.sessionId = "session-2";

    await page.placeAs("Tariro");
    expect(bodies(page)).toHaveLength(1);
    await page.placeAs("Tariro");

    expect(bodies(page)[1].get("session")).toBe("session-2");
  });

  it("keeps a cart changed since, saying the first order went through, and can then place it", async () => {
    const page = await lostOrder();
    await page.add(page.rice);
    page.state.orderReply = { status: 409, json: { error: "Your earlier order went through.", code: "already_placed" } };
    await page.placeAs("Tariro");

    expect(page.cart.children).toHaveLength(2);
    expect(page.error.textContent).toBe("Your earlier order went through.");

    page.state.orderReply = undefined;
    await page.placeAs("Tariro");
    const [first, second, third] = bodies(page);
    expect(second.get("request")).toBe(first.get("request"));
    expect(third.get("request")).not.toBe(first.get("request"));
    expect(page.cart.children).toHaveLength(0);
  });
});

describe("a cart left over from a session that ended (#85)", () => {
  const bodies = (page: Awaited<ReturnType<typeof loadPage>>) =>
    page.state.requests.filter((request) => request.path === "/orders").map((request) => request.body!);
  const submit = async (page: Awaited<ReturnType<typeof loadPage>>) => {
    await page.form.dispatch("submit");
    await settle();
  };

  /** A remembered name and one stew in the cart, then staff close the table. */
  async function leftOver(next: string | null) {
    const page = await loadPage(new Map([["order-name:session-1", "Tariro"]]), "session-1");
    await page.add(page.stew);
    page.state.sessionId = "session-2";
    page.state.feed = { session: next, items: [] };
    await page.tick();
    return page;
  }

  it.each([
    ["nobody has opened the next session", null],
    ["another phone has already opened the next one", "session-2"],
  ])("sends nothing, asks for the name again and keeps the cart when %s", async (_what, next) => {
    const page = await leftOver(next);
    expect(page.name.value).toBe("Tariro");

    await submit(page);
    expect(bodies(page)).toEqual([]);
    expect(page.name.value).toBe("");
    expect(page.cart.children).toHaveLength(1);
    expect(page.form.hidden).toBe(false);
    expect(page.error.textContent).toMatch(/session has ended.*check your order/i);

    await submit(page);
    expect(bodies(page)).toEqual([]);
    expect(page.error.textContent).toBe("Enter a name for the waiter.");

    await page.placeAs("Rudo");
    expect(bodies(page)).toHaveLength(1);
    expect(bodies(page)[0].get("session")).toBe("session-2");
    expect(bodies(page)[0].get("name")).toBe("Rudo");
  });

  it("stops saying the session has ended once Place order has joined the next one", async () => {
    const page = await leftOver("session-2");
    await submit(page);
    expect(page.trackerState.textContent).toBe("");
  });

  it("asks before sending an old line with one added in the next session", async () => {
    const page = await leftOver("session-2");
    await page.add(page.rice);
    expect(page.name.value).toBe("");

    await page.placeAs("Rudo");
    expect(bodies(page)).toEqual([]);
    expect(page.error.textContent).toMatch(/session has ended/i);

    await submit(page);
    expect(bodies(page)[0].getAll("item")).toEqual(["item-stew", "item-rice"]);
    expect(bodies(page)[0].get("name")).toBe("Rudo");
  });

  it("asks after a waiter call has joined the next session", async () => {
    const page = await leftOver("session-2");
    await page.waiter.dispatch("click");
    await settle();

    await page.placeAs("Rudo");
    expect(bodies(page)).toEqual([]);

    await submit(page);
    expect(bodies(page)).toHaveLength(1);
  });

  it("asks again if the next session has ended too by the time the guest confirms", async () => {
    const page = await leftOver("session-2");
    await submit(page);
    page.state.sessionId = "session-3";
    page.state.feed = { session: "session-3", items: [] };
    await page.tick();

    await page.placeAs("Rudo");
    expect(bodies(page)).toEqual([]);
    expect(page.name.value).toBe("");
  });

  it("doesn't ask about a cart started after the session ended", async () => {
    const page = await leftOver(null);
    await page.buttonLabelled("Remove").dispatch("click");
    await page.add(page.rice);

    await page.placeAs("Rudo");
    expect(bodies(page)[0].getAll("item")).toEqual(["item-rice"]);
    expect(bodies(page)[0].get("session")).toBe("session-2");
  });

  it("goes straight on when staff reopened the same session", async () => {
    const page = await leftOver(null);
    page.state.sessionId = "session-1";

    await submit(page);
    expect(bodies(page)[0].get("session")).toBe("session-1");
    expect(bodies(page)[0].get("name")).toBe("Tariro");
  });

  it("counts a line added while ended, whose join failed, as current once the session is seen reopened", async () => {
    const page = await loadPage(new Map([["order-name:session-1", "Tariro"]]), "session-1");
    page.state.feed = { session: null, items: [] };
    await page.tick();
    page.state.joinReplies.push("abort");
    await page.add(page.stew);
    page.state.feed = { session: "session-1", items: [] };
    await page.tick();

    await submit(page);
    expect(bodies(page)).toHaveLength(1);
    expect(bodies(page)[0].get("session")).toBe("session-1");
  });

  it("clears the name and asks once when the server is first to say the session changed", async () => {
    const page = await loadPage(new Map([["order-name:session-1", "Tariro"]]), "session-1");
    await page.add(page.stew);
    page.state.sessionId = "session-2";
    page.state.orderReply = { status: 409, json: { error: "reset", code: "session_changed" } };
    await submit(page);
    page.state.orderReply = undefined;
    expect(page.error.textContent).toBe("reset");

    await submit(page);
    expect(bodies(page)).toHaveLength(1);
    await page.placeAs("Rudo");
    expect(bodies(page)[1].get("session")).toBe("session-2");
  });

  it("asks before sending the rest, after a lost order's retry found it had been placed (#84)", async () => {
    const page = await loadPage(new Map(), "session-1");
    page.state.loseOrderReply = true;
    await page.orderOne("Tariro");
    page.state.loseOrderReply = false;
    page.state.sessionId = "session-2";
    page.state.feed = { session: "session-2", items: [] };
    await page.tick();
    await page.add(page.rice);
    page.state.orderReply = { status: 409, json: { error: "Already.", code: "already_placed" } };
    await page.placeAs("Rudo");
    page.state.orderReply = undefined;
    expect(bodies(page)[1].get("session")).toBe("session-1");

    await submit(page);
    expect(bodies(page)).toHaveLength(2);
    expect(page.error.textContent).toMatch(/session has ended/i);
    await submit(page);
    expect(bodies(page)[2].get("session")).toBe("session-2");
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

/** Sent, and no more than that: nobody has acknowledged it yet (#97). */
const SENT = "Your table's call has been sent to the staff.";
const SEEN = "The staff have seen your table's call.";

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
    expect(page.waiterStatus.textContent).toBe(SENT);
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
    expect(page.waiterStatus.textContent).toBe(SENT);
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

describe("a waiter call follows the server (#97)", () => {
  type Page = Awaited<ReturnType<typeof loadPage>>;
  const call = async (page: Page) => {
    await page.waiter.dispatch("click");
    await settle();
    await settle();
  };
  const tickWith = async (page: Page, feed: Feed) => {
    page.state.feed = feed;
    await page.tick();
  };
  const shows = (page: Page) => ({
    called: "called" in page.waiter.dataset,
    says: page.waiterStatus.textContent,
  });
  const IDLE = { called: false, says: "" };
  const PENDING = { called: true, says: SENT };

  it("never claims a waiter is coming before anyone has acknowledged the call", async () => {
    const page = await loadPage(new Map(), "session-1");
    await call(page);
    expect(page.waiterStatus.textContent).not.toMatch(/way|coming|will|soon/i);
    expect(ORDER_SCRIPT).not.toMatch(/on the way/i);
  });

  it("a reload keeps a pending call, from the first poll", async () => {
    const page = await loadPage(new Map(), "session-1", {
      feed: { session: "session-1", items: [], waiter: true },
    });
    expect(shows(page)).toEqual(PENDING);
  });

  it("stays pending while the server says so", async () => {
    const page = await loadPage(new Map(), "session-1");
    await call(page);
    await page.tick();
    await page.tick();
    expect(shows(page)).toEqual(PENDING);
  });

  it("says staff have seen it once it is dismissed, and can be called again", async () => {
    const page = await loadPage(new Map(), "session-1");
    await call(page);
    await tickWith(page, { session: "session-1", items: [], waiter: false });
    expect(shows(page)).toEqual({ called: false, says: SEEN });

    await call(page);
    expect(shows(page)).toEqual(PENDING);
  });

  it("is dropped when the session ends, whether or not it had been seen", async () => {
    for (const seen of [false, true]) {
      const page = await loadPage(new Map(), "session-1");
      await call(page);
      if (seen) await tickWith(page, { session: "session-1", items: [], waiter: false });
      await tickWith(page, { session: null, items: [], waiter: false });
      expect(shows(page)).toEqual(IDLE);
    }
  });

  it("never shows another session's call: the next party's on an old page, or the old one's after joining", async () => {
    const page = await loadPage(new Map(), "session-1");
    await call(page);
    await tickWith(page, { session: "session-2", items: [], waiter: true });
    expect(shows(page)).toEqual(IDLE);
  });

  it("drops the old session's call when an order is what finds the session changed", async () => {
    const page = await loadPage(new Map(), "session-1");
    await call(page);
    await page.add(page.stew);
    page.state.sessionId = "session-2";
    page.state.feed = { session: "session-2", items: [], waiter: false };
    page.state.orderReply = { status: 409, json: { error: "Ended.", code: "session_changed" } };
    await page.placeAs("Tariro");
    expect(shows(page)).toEqual(IDLE);

    await page.tick();
    expect(shows(page)).toEqual(IDLE);
  });

  it("shows a call another phone at the table made", async () => {
    const page = await loadPage(new Map(), "session-1");
    await tickWith(page, { session: "session-1", items: [], waiter: true });
    expect(shows(page)).toEqual(PENDING);
  });

  it("a poll asked before the call went through can't take it for dismissed", async () => {
    const page = await loadPage(new Map(), "session-1");
    page.state.holdPolls = true;
    await page.tick();
    await call(page);
    page.state.holdPolls = false;
    await page.answer();
    expect(shows(page)).toEqual(PENDING);

    await tickWith(page, { session: "session-1", items: [], waiter: false });
    expect(shows(page)).toEqual({ called: false, says: SEEN });
  });

  it("a call answered late, after staff dismissed it, ends as dismissed", async () => {
    const page = await loadPage(new Map(), "session-1");
    page.state.holdWaiter = true;
    void page.waiter.dispatch("click");
    await settle();
    await tickWith(page, { session: "session-1", items: [], waiter: false });
    await page.answerCall();
    expect(shows(page)).toEqual({ called: false, says: SEEN });
  });

  it("a failed call the server did get is shown as sent by the next poll", async () => {
    const page = await loadPage(new Map(), "session-1");
    page.state.waiterReply = { status: 500, json: {} };
    await call(page);
    expect(page.waiterStatus.dataset.tone).toBe("error");
    await tickWith(page, { session: "session-1", items: [], waiter: true });
    expect(shows(page)).toEqual(PENDING);
    expect(page.waiterStatus.dataset.tone).toBeUndefined();
  });

  it("leaves a problem with the order up in the shared place, and the button still follows the server", async () => {
    const page = await loadPage(new Map(), "session-1");
    await call(page);
    await page.add(page.stew);
    page.state.orderReply = {
      status: 409,
      json: { error: "Beef stew has sold out.", code: "unavailable", item: "item-stew" },
    };
    await page.placeAs("Tariro");
    await tickWith(page, { session: "session-1", items: [], waiter: false });
    expect(shows(page)).toEqual({ called: false, says: "Beef stew has sold out." });
    expect(page.waiterStatus.dataset.tone).toBe("error");
  });

  it("the join's message gives way to a pending call once the join works (#98)", async () => {
    const page = await loadPage(new Map(), "session-1", {
      joinReplies: ["abort"],
      feed: { session: "session-1", items: [], waiter: true },
    });
    expect(page.waiterStatus.textContent).toMatch(/couldn't reach/i);
    expect(page.waiter.dataset).not.toHaveProperty("called");

    await page.retryNow();
    expect(shows(page)).toEqual(PENDING);
    expect(page.waiterStatus.dataset.tone).toBeUndefined();
  });

  it("isn't written again by a poll that changes something else", async () => {
    const page = await loadPage(new Map(), "session-1");
    await call(page);
    const item = { quantity: 1, name: "Rice", note: null, customer: "Farai", status: "placed", time: "12:00" };
    page.waiterStatus.textContent = "";
    await tickWith(page, { session: "session-1", items: [item], waiter: true });
    // A status region written again is read out again.
    expect(page.waiterStatus.textContent).toBe("");
  });
});
