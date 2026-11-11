import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { bookAgainPath } from "@/lib/booking-link";
import { html, trusted } from "@/lib/html";
import { getMenu, type Menu } from "@/lib/menu";
import { menuTag } from "@/lib/menu-cache";
import { photoUrls } from "@/lib/photo-urls";
import { type PromotionSlot, priceDisplay, promotionDisplay } from "@/lib/pricing";
import { type PublicTokenKind, resolvePublicToken } from "@/lib/tenant/public";

/**
 * The customer's menu page (spec 02), shared by every public URL that shows it.
 * Written as a string because an App Router page can't leave out the framework's
 * scripts, which alone break the budget (S-32). The whole of it is below: no web
 * fonts, one inline stylesheet, so one request draws the page. The generic menu
 * has no JavaScript at all. A table's page adds ordering (spec 06): Add buttons,
 * an order form and one small inline script, which talks to the uncached
 * endpoints under /api/t/ (S-32, proposed). Nothing about a session is ever
 * written into the page, which is cached and the same for everyone at the table.
 */

/** Cache Components needs one sample per route at build, which has no database. */
export const BUILD_SAMPLE_TOKEN = "build-sample";

/** Issue 24: a special starts or ends within this long of its window. */
const FRESH_FOR_SECONDS = 5 * 60;

const styles = `
:root{color-scheme:light dark;--muted:#5f5f5f;--line:#e2e2e2}
@media (prefers-color-scheme:dark){:root{--muted:#a8a8a8;--line:#3a3a3a}}
*{box-sizing:border-box}
body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:40rem;margin:0 auto;padding:1.5rem 1rem 3rem}
h1{margin:0;font-size:1.75rem;line-height:1.2}
.wifi{margin:.25rem 0 0;font-size:.9rem}
.book-again{margin:.5rem 0 0}
nav{position:sticky;top:0;z-index:1;display:flex;gap:.5rem;margin:1rem -1rem 0;padding:.5rem 1rem;overflow-x:auto;background:Canvas;border-bottom:1px solid var(--line)}
nav a{flex:none;padding:.25rem .75rem;border:1px solid var(--line);border-radius:999px;color:inherit;font-size:.9rem;text-decoration:none;white-space:nowrap}
section{scroll-margin-top:3.5rem}
html{scroll-behavior:smooth}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
h2{margin:1.5rem 0 0;padding-bottom:.25rem;border-bottom:1px solid var(--line);font-size:1.25rem}
ul{margin:0;padding:0;list-style:none}
li{display:flex;align-items:flex-start;gap:.75rem;padding:.75rem 0;border-bottom:1px solid var(--line)}
.text{flex:1;min-width:0}
.thumb{flex:none;width:64px;height:64px;object-fit:cover;border-radius:.375rem;background:var(--line)}
.item{display:flex;justify-content:space-between;gap:1rem;font-weight:600}
.price{white-space:nowrap;text-align:right}
.sub{display:block;font-size:.8rem;font-weight:400;color:var(--muted)}
.sold-out{color:var(--muted)}
.sold-out .thumb{opacity:.5}
s{font-weight:400;color:var(--muted)}
.tag{margin-left:.5rem;padding:0 .3rem;border:1px solid currentColor;border-radius:.25rem;font-size:.75rem;font-style:normal;font-weight:600;text-transform:uppercase;letter-spacing:.04em;vertical-align:middle}
p{margin:.25rem 0 0;color:var(--muted)}
`;

const stylesheet = trusted(styles);

type Markup = ReturnType<typeof html>;

const page = (title: string, body: Markup, after: Markup | null = null) =>
  html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${stylesheet}</style>
</head>
<body><main>${body}</main>${after}</body>
</html>
`;

// --- ordering, on a table's page only (spec 06) ------------------------------

const orderStyles = trusted(`[hidden]{display:none!important}
.add{margin-top:.5rem;padding:.25rem .9rem;border:1px solid currentColor;border-radius:999px;background:none;color:inherit;font:inherit;font-size:.9rem}
.order{position:fixed;inset:auto 0 0;display:flex;flex-direction:column;gap:.5rem;max-width:40rem;max-height:90vh;margin:0 auto;padding:1rem;overflow-y:auto;background:Canvas;border-top:1px solid var(--line);box-shadow:0 -4px 16px rgb(0 0 0/.15)}
.order h2{margin:0;padding:0;border:0;font-size:1.1rem}
.order label{display:flex;flex-direction:column;gap:.2rem;font-size:.9rem}
.order input{padding:.5rem;border:1px solid var(--line);border-radius:.375rem;font:inherit;font-size:16px}
.order .actions{display:flex;gap:.5rem}
.order button,.bar{padding:.6rem;border-radius:.375rem;font:inherit}
.order .actions button{flex:1}
#cart li{flex-wrap:wrap;align-items:center;gap:.5rem;padding:.5rem 0}
#cart .what{flex:1 1 100%}
#cart .note{flex:1 1 8rem;min-width:0}
#cart .step{padding:.25rem .75rem}
.bar{position:fixed;inset:auto 1rem 1rem;max-width:38rem;margin:0 auto;border:0;background:CanvasText;color:Canvas;font-weight:600}
.order:not([hidden])~.bar{display:none}
.order-status{position:fixed;inset:auto 1rem 4.5rem;max-width:38rem;margin:0 auto;padding:.75rem 1rem;border-radius:.375rem;background:CanvasText;color:Canvas}
.order-status:empty{display:none}
.tracker{max-width:40rem;margin:0 auto;padding:0 1rem 1rem}
.waiter{max-width:40rem;margin:0 auto;padding:0 1rem 6rem}
.tracker h2{margin:0}
.tracker li{flex-wrap:wrap;gap:.25rem .75rem}
.tracker .who{flex:1 1 100%}
.voided .what{text-decoration:line-through;color:var(--muted)}`);

/**
 * The cart, the name, placing the order, and the order tracker (spec 06, steps 1,
 * 2, 3 and 5; #70, proposed, S-40). Plain DOM, no framework, so it costs about
 * 5KB on the page (spec 02's budget). The token comes from the address, the
 * session from the scan it makes on load: the page itself carries neither.
 * Everything a customer typed or a menu says is put on the page as text, never
 * as markup. The cart lives in the page only; what the phone remembers is the
 * customer's name, per session, so the next party at the table starts blank.
 * The tracker is polled from an uncached endpoint every 5 seconds *(proposed)*,
 * only while the page is showing, one poll at a time, each given up after 4
 * seconds, so a slow line can't pile them up or land an older answer over a newer
 * one: a tick during a poll is skipped, and a poll asked for after an order runs
 * once the one in flight is done. "Call a waiter" *(proposed, #77)* posts to its own
 * endpoint, one call at a time, and says on the page that it went through; the
 * page keeps nothing of it, since the floor view owns when a call ends. A session the table has left behind (staff
 * cleared it, or another party opened a new one) is said to have ended, and the
 * next Add or Place order joins the table's fresh one.
 */
export const ORDER_SCRIPT = `(() => {
  const api = (path) => "/api/t/" + encodeURIComponent(location.pathname.split("/")[2]) + path;
  const $ = (id) => document.getElementById(id);
  const form = $("order");
  const fields = form.elements;
  const status = $("order-status");
  const bar = $("cart-open");
  const list = $("cart");
  const tracker = $("tracker");
  const waiter = $("call-waiter");
  const feedList = $("tracker-list");
  const feedState = $("tracker-state");
  const say = (text) => { status.textContent = text; };
  const make = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const times = (quantity, name) => quantity + " \\u00d7 " + name;
  let session = null;
  let ended = false;
  let cart = [];
  const join = async () => {
    const response = await fetch(api("/session"), { method: "POST" });
    if (!response.ok) throw new Error(String(response.status));
    const next = (await response.json()).session;
    if (session && next !== session) fields.name.value = "";
    session = next;
    ended = false;
    try { fields.name.value = localStorage.getItem("order-name:" + session) || fields.name.value; } catch {}
  };

  const draw = () => {
    bar.hidden = cart.length === 0;
    bar.textContent = "Your order (" + cart.reduce((sum, line) => sum + line.quantity, 0) + ")";
    if (cart.length === 0) form.hidden = true;
    list.replaceChildren(...cart.map((line) => {
      const row = make("li");
      const what = make("span", times(line.quantity, line.name), "what");
      if (line.price) what.textContent += " \\u00b7 " + line.price + (line.quantity > 1 ? " each" : "");
      const change = (by, label) => {
        const button = make("button", by < 0 ? "\\u2212" : "+", "step");
        button.type = "button";
        button.setAttribute("aria-label", label + line.name);
        button.addEventListener("click", () => {
          line.quantity = Math.min(20, line.quantity + by);
          if (line.quantity < 1) cart = cart.filter((other) => other !== line);
          draw();
        });
        return button;
      };
      const note = make("input", undefined, "note");
      note.maxLength = 200;
      note.placeholder = "Note for the kitchen (optional)";
      note.value = line.note;
      note.setAttribute("aria-label", "Note for " + line.name);
      note.addEventListener("input", () => { line.note = note.value; });
      const remove = make("button", "Remove");
      remove.type = "button";
      remove.addEventListener("click", () => { cart = cart.filter((other) => other !== line); draw(); });
      row.append(what, change(-1, "One fewer "), change(1, "One more "), remove, note);
      return row;
    }));
  };

  const words = { placed: "Ordered", cooking: "Cooking", done: "Ready", delivered: "Delivered", voided: "Voided" };
  let shown = false;
  let last = "";
  let polling = false;
  let again = false;
  const poll = async (fresh) => {
    if (!session) return;
    if (polling) { again = again || fresh; return; }
    polling = true;
    try {
      const response = await fetch(api("/tracker"), AbortSignal.timeout ? { signal: AbortSignal.timeout(4000) } : {});
      if (!response.ok) return;
      const feed = await response.json();
      const text = JSON.stringify(feed);
      if (text === last) return;
      last = text;
      ended = feed.session !== session;
      const items = ended ? [] : feed.items;
      if (!ended) shown = items.length > 0;
      tracker.hidden = !shown;
      feedState.textContent = ended ? "This table's session has ended. Add an item to start a new one." : "";
      feedList.replaceChildren(...items.map((item) => {
        const row = make("li", undefined, item.status === "voided" ? "voided" : "");
        row.append(
          make("span", times(item.quantity, item.name), "what"),
          make("em", words[item.status] || item.status, "tag"),
          make("span", (item.note ? "Note: " + item.note + " \\u00b7 " : "") + item.customer + " \\u00b7 " + item.time, "sub who"),
        );
        return row;
      }));
    } catch {} finally {
      polling = false;
      if (again) { again = false; poll(); }
    }
  };

  join().then(() => {
    for (const button of document.querySelectorAll("button[data-item]")) button.hidden = false;
    waiter.hidden = false;
    poll();
    setInterval(() => { if (!document.hidden) poll(); }, 5000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
  }, () => {});

  document.addEventListener("click", async (event) => {
    const button = event.target instanceof Element && event.target.closest("button[data-item]");
    if (!button) return;
    const line = cart.find((other) => other.id === button.dataset.item);
    if (line) line.quantity = Math.min(20, line.quantity + 1);
    else if (cart.length >= 20) return say("An order can have up to 20 different items.");
    else cart.push({ id: button.dataset.item, name: button.dataset.name, price: button.dataset.price || "", quantity: 1, note: "" });
    say("");
    draw();
    if (ended) await join().then(() => { last = ""; return poll(true); }, () => {});
  });
  waiter.addEventListener("click", async () => {
    if (waiter.disabled) return;
    waiter.disabled = true;
    try {
      const response = await fetch(api("/waiter"), { method: "POST" });
      if (!response.ok) throw new Error(String(response.status));
      const next = (await response.json()).session;
      if (next !== session) {
        fields.name.value = "";
        session = next;
        ended = false;
        last = "";
        poll(true);
      }
      say("A waiter has been called and is on the way.");
    } catch {
      say("That didn't go through. Check your connection and try again.");
    } finally {
      waiter.disabled = false;
    }
  });
  bar.addEventListener("click", () => { form.hidden = false; say(""); });
  $("order-cancel").addEventListener("click", () => { form.hidden = true; });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = fields.name.value.trim();
    if (cart.length === 0) return;
    if (!name) return say("Enter a name for the waiter.");
    fields.place.disabled = true;
    try {
      if (ended) await join();
      const body = new URLSearchParams();
      for (const line of cart) {
        body.append("item", line.id);
        body.append("quantity", String(line.quantity));
        body.append("note", line.note);
      }
      body.set("name", name);
      body.set("session", session || "");
      const response = await fetch(api("/orders"), { method: "POST", body });
      const answer = await response.json().catch(() => ({}));
      if (response.status === 201) {
        try { localStorage.setItem("order-name:" + session, name); } catch {}
        cart = [];
        draw();
        say("Ordered: " + answer.placed.lines.map((line) => times(line.quantity, line.name)).join(", ") + ". Pay at the table with your waiter as usual.");
        last = "";
        poll(true);
        return;
      }
      if (answer.code === "session_changed") await join().catch(() => {});
      if (answer.code === "unavailable") {
        cart = cart.filter((line) => line.id !== answer.item);
        draw();
      }
      say(answer.error || "That didn't go through. Try again.");
    } catch {
      say("That didn't go through. Check your connection and try again.");
    } finally {
      fields.place.disabled = false;
    }
  });
})();`;

const orderScript = trusted(ORDER_SCRIPT);

const orderBlock = html`
<style>${orderStyles}</style>
<section id="tracker" class="tracker" aria-live="polite" hidden>
<h2>Your table's orders</h2>
<p id="tracker-state"></p>
<ul id="tracker-list"></ul>
<p>Pay at the table with your waiter as usual.</p>
</section>
<p class="waiter"><button type="button" id="call-waiter" class="add" hidden>Call a waiter</button></p>
<form id="order" class="order" hidden>
<h2>Your order</h2>
<ul id="cart"></ul>
<label>Name for the waiter <input name="name" maxlength="100" required autocomplete="given-name"></label>
<p>Pay at the table with your waiter as usual.</p>
<div class="actions"><button type="button" id="order-cancel">Keep browsing</button><button name="place">Place order</button></div>
</form>
<button type="button" id="cart-open" class="bar" hidden></button>
<p id="order-status" class="order-status" role="status"></p>
<script>${orderScript}</script>
`;

type Item = Menu["categories"][number]["items"][number];

/** The struck-through normal price, when this line has one, then the price now. */
const slot = ({ was, now }: PromotionSlot) => html`${was !== undefined && html`<s>${was}</s> `}${now}`;

/** What the cart shows beside a line: the price the menu shows, in the restaurant's currency mode. */
const shownPrice = (item: Item, { currencyMode, pricing }: Menu) =>
  item.special
    ? promotionDisplay(item, item.special, currencyMode, pricing).main.now
    : priceDisplay(item, currencyMode, pricing).main;

const priceCell = (item: Item, { currencyMode, pricing }: Menu) => {
  if (item.special) {
    const { main, sub } = promotionDisplay(item, item.special, currencyMode, pricing);
    return html`<span class="price">${slot(main)}${sub && html`<span class="sub">${slot(sub)}</span>`}</span>`;
  }
  const { main, sub } = priceDisplay(item, currencyMode, pricing);
  return html`<span class="price">${main}${sub && html`<span class="sub">${sub}</span>`}</span>`;
};

/**
 * The 320px file, shown at 64px: fixed width and height so the text doesn't move
 * when it arrives, and lazy so a long menu doesn't fetch every photo up front.
 * Empty alt, because the name is beside it.
 */
const thumbnail = ({ photoKey }: Item) =>
  photoKey !== null &&
  html`<img class="thumb" src="${photoUrls(photoKey).thumb}" width="64" height="64" loading="lazy" decoding="async" alt="">`;

/**
 * Hidden until the script has joined the table's session: without JavaScript, or
 * with a code that no longer works, the page is the plain menu. Only on an item
 * that can be ordered now; the order endpoint checks again.
 */
const addButton = (item: Item, menu: Menu, ordering: boolean) =>
  ordering &&
  item.available &&
  html`<button type="button" class="add" data-item="${item.id}" data-name="${item.name}" data-price="${shownPrice(item, menu)}" hidden>Add</button>`;

const itemRow = (item: Item, menu: Menu, ordering: boolean) => html`<li class="${item.available ? "" : "sold-out"}">
<div class="text">
<div class="item"><span>${item.name}${item.special && html`<em class="tag">${item.special.title ?? "Special"}</em>`}${!item.available && html`<em class="tag">Sold out</em>`}</span>${priceCell(item, menu)}</div>
${item.description && html`<p>${item.description}</p>`}${addButton(item, menu, ordering)}
</div>
${thumbnail(item)}
</li>`;

/** Only on a table's page (spec 03), and only while booking is on. */
const bookAgainLine = (path: string | null) =>
  path === null ? "" : html`<p class="book-again"><a href="${path}">Book again</a></p>\n`;

/** Sold-out items stay on the page, after the rest of their category (spec 02). */
const availableFirst = (items: Item[]) =>
  [...items].sort((a, b) => Number(!a.available) - Number(!b.available));

/**
 * Whatever is on special now, at the top (spec 02). Each promoted item is also in
 * its own category, with the same price, so the two never disagree. A bundle is
 * only here: it has no category on the page.
 */
function specialsSection(menu: Menu, ordering: boolean) {
  const onSpecial = availableFirst(
    [
      ...menu.categories.flatMap((category) => category.items).filter((item) => item.special),
      ...menu.bundles,
    ],
  );
  if (onSpecial.length === 0) return null;
  return html`<section id="specials">
<h2>Specials</h2>
<ul>${onSpecial.map((item) => itemRow(item, menu, ordering))}</ul>
</section>`;
}

function menuPage(menu: Menu, bookAgain: string | null, ordering: boolean) {
  const shown = menu.categories.filter((category) => category.items.length > 0);
  const specials = specialsSection(menu, ordering);
  // Anchors are positions, not ids from the database: nothing internal on the page.
  const anchorOf = (index: number) => `c${index + 1}`;
  const sections = shown.map(
    (category, index) => html`<section id="${anchorOf(index)}">
<h2>${category.name}</h2>
<ul>${availableFirst(category.items).map((item) => itemRow(item, menu, ordering))}</ul>
</section>`,
  );
  // A plain list of anchors, so it works without JavaScript (spec 02).
  const jumpBar =
    (sections.length > 0 || specials) &&
    html`<nav aria-label="Menu sections">${specials && html`<a href="#specials">Specials</a>`}${shown.map(
      (category, index) => html`<a href="#${anchorOf(index)}">${category.name}</a>`,
    )}</nav>`;

  return page(
    menu.restaurantName,
    html`<h1>${menu.restaurantName}</h1>
${menu.wifiName && html`<p class="wifi">Wi-Fi: ${menu.wifiName}</p>`}
${bookAgainLine(bookAgain)}${jumpBar}
${specials}
${sections.length > 0 || specials ? sections : html`<p>This menu isn't up yet.</p>`}`,
    ordering ? orderBlock : null,
  );
}

const noSuchMenu = page(
  "Menu not found",
  html`<h1>Menu not found</h1>
<p>Check the link, or ask a member of staff for the menu.</p>`,
);

/** A table's code that no longer leads anywhere: regenerated, archived or never made. */
const codeOutOfDate = page(
  "Code out of date",
  html`<h1>This code is out of date</h1>
<p>Ask a member of staff for help.</p>`,
);

/**
 * The page for a token, or null if it names no restaurant. Everything the token
 * leads to is in here, so the response caches whole. Its tag is the restaurant's,
 * not the token's: the editor knows only the restaurant, and a table's token
 * must refresh with the rest.
 */
async function cachedPage(kind: PublicTokenKind, token: string) {
  "use cache";
  const tenant =
    token === BUILD_SAMPLE_TOKEN ? undefined : await resolvePublicToken(kind, token);
  if (!tenant) {
    // No restaurant means no tag, and so nothing to revalidate it.
    cacheLife("minutes");
    return null;
  }

  // Prices only change on a save, but a special's window opens and closes without
  // one, and a render overlapping a save can store the old page after the tag has
  // expired. expire is the same as revalidate so that this is a ceiling: otherwise
  // the first visit after a quiet spell would still get the old page.
  cacheLife({ revalidate: FRESH_FOR_SECONDS, expire: FRESH_FOR_SECONDS });
  cacheTag(menuTag(tenant.restaurantId));
  const table = kind === "table";
  const bookAgain = table ? await bookAgainPath(tenant) : null;
  // Only a table's code takes orders: the generic menu never does (spec 03).
  return menuPage(await getMenu(tenant), bookAgain, table).toString();
}

export async function publicMenuResponse(kind: PublicTokenKind, token: string) {
  const menu = await cachedPage(kind, token);
  const missing = kind === "table" ? codeOutOfDate : noSuchMenu;
  return new Response(menu ?? missing.toString(), {
    status: menu === null ? 404 : 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
