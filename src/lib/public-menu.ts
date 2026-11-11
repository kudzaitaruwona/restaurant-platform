import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { bookAgainPath } from "@/lib/booking-link";
import { guestThemeCss } from "@/lib/guest-theme";
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

/**
 * The page's own layout, on top of the guest theme (S-41): a header with the
 * restaurant's name, sticky category chips, and card-less rows split by
 * hairlines, with the photo on the left and the price on the right.
 */
const styles = `
[hidden]{display:none!important}
html{scroll-behavior:smooth}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
main{max-width:40rem;margin:0 auto;padding-bottom:40px}
.head{padding:24px 16px 16px}
.hrow{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
h1{margin:0;font-size:24px;font-weight:600;line-height:1.25;letter-spacing:-.01em;text-wrap:balance}
.head p{margin:4px 0 0;font-size:15px;color:var(--ink-2)}
.wifi{display:flex;align-items:center;gap:6px}
.wifi .icon{width:16px;height:16px}
.head .book-again{margin-top:8px}
.book-again a{color:var(--ink);font-weight:600;text-underline-offset:3px}
nav{position:sticky;top:0;z-index:2;display:flex;gap:8px;padding:8px 16px;overflow-x:auto;background:var(--bg);border-bottom:1px solid var(--line);scrollbar-width:none}
nav::-webkit-scrollbar{display:none}
nav a{display:inline-flex;align-items:center;flex:none;min-height:44px;padding:0 16px;border:1px solid var(--line);border-radius:999px;background:var(--surface);font-size:15px;font-weight:500;text-decoration:none;white-space:nowrap}
nav a:active{background:var(--surface-2)}
.sections section{padding:0 16px;scroll-margin-top:61px}
.sections h2{margin:28px 0 4px;font-size:20px;font-weight:600;line-height:1.3}
.sections>p{padding:0 16px;color:var(--ink-2)}
ul{margin:0;padding:0;list-style:none}
.sections li{display:flex;gap:12px;padding:16px 0}
.sections li+li{border-top:1px solid var(--line)}
.thumb{flex:none;width:64px;height:64px;border-radius:10px;object-fit:cover;background:var(--surface-2)}
.body{flex:1;min-width:0;display:flex;justify-content:space-between;gap:12px}
.left{display:flex;flex-direction:column;align-items:flex-start;min-width:0}
.right{display:flex;flex-direction:column;align-items:flex-end;gap:8px;flex:none;max-width:50%}
.name{font-weight:600;line-height:1.35}
.price{font-weight:600;line-height:1.35;text-align:right;font-variant-numeric:tabular-nums}
.sub{display:block;font-size:13px;font-weight:400;color:var(--ink-2)}
.desc{margin:2px 0 0;font-size:15px;line-height:1.45;color:var(--ink-2)}
.tag{display:inline-flex;align-items:center;height:22px;margin-left:8px;padding:0 8px;border-radius:999px;background:var(--surface-2);color:var(--ink-2);font-size:13px;font-style:normal;font-weight:600;vertical-align:2px}
.sold-out .name,.sold-out .price{color:var(--ink-2)}
.sold-out .thumb{opacity:.5}
s{font-weight:400;color:var(--ink-2)}
`;

const stylesheet = trusted(guestThemeCss + styles);

type Markup = ReturnType<typeof html>;

const page = (title: string, body: Markup, after: Markup | null = null) =>
  html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<style>${stylesheet}</style>
</head>
<body><main>${body}</main>${after}</body>
</html>
`;

/** An inline Lucide icon (S-41): its own paths, drawn by the theme's .icon. */
const icon = (paths: string, className = "icon") =>
  `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;

const WIFI = trusted(
  icon(
    '<path d="M12 20h.01"/><path d="M2 8.82a15 15 0 0 1 20 0"/><path d="M5 12.859a10 10 0 0 1 14 0"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/>',
  ),
);
const BELL =
  '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>';

// --- ordering, on a table's page only (spec 06) ------------------------------

/** A Lucide icon drawn by CSS, for the elements the script makes. */
const mask = (paths: string) =>
  `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>${paths}</svg>`,
  )}")`;

const orderStyles = trusted(`:root{--i-check:${mask("<path d='M20 6 9 17l-5-5'/>")};--i-ok:${mask("<circle cx='12' cy='12' r='10'/><path d='m9 12 2 2 4-4'/>")};--i-trash:${mask("<path d='M3 6h18'/><path d='M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6'/><path d='M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2'/><path d='M10 11v6'/><path d='M14 11v6'/>")}}
main{padding-bottom:104px}
.ico::before{content:"";flex:none;width:16px;height:16px;background:currentColor;-webkit-mask:var(--i) center/contain no-repeat;mask:var(--i) center/contain no-repeat}
.waiter{display:inline-flex;align-items:center;gap:8px;flex:none;min-height:44px;padding:0 14px;border:1px solid var(--line);border-radius:10px;background:var(--surface);color:var(--ink);font-size:15px;font-weight:600;cursor:pointer;transition:background-color .18s ease-out,border-color .18s ease-out,color .18s ease-out;touch-action:manipulation}
.waiter:active{transform:translateY(1px)}
.waiter .ring,.waiter .w1,.waiter[data-called] .bell,.waiter[data-called] .w0{display:none}
.waiter[data-called] .ring{display:block}.waiter[data-called] .w1{display:inline}
.waiter[data-called]{background:var(--attention-soft);border-color:var(--attention);color:var(--attention-ink)}
@media (prefers-reduced-motion:no-preference){.waiter[data-called] .ring{animation:ring 2.4s ease-out 3}}
@keyframes ring{0%,60%,100%{transform:rotate(0)}10%{transform:rotate(-14deg)}20%{transform:rotate(12deg)}30%{transform:rotate(-8deg)}40%{transform:rotate(4deg)}}
.said{margin:-4px 16px 16px;padding:10px 12px;border-radius:10px;background:var(--attention-soft);color:var(--attention-ink);font-size:15px;font-weight:600}
.said:empty,.confirm:empty,.err:empty,.tstate:empty,.inorder:empty{display:none}
.tracker{margin:0 16px 16px;padding:16px;border:1px solid var(--line);border-radius:14px;background:var(--surface)}
.tracker h2{margin:0;font-size:17px;font-weight:600}
.tstate{margin:8px 0 0;color:var(--ink-2);font-size:15px}
.tracker ul{margin-top:8px}
.tracker li{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:10px 0}
.tracker li+li{border-top:1px solid var(--line)}
.tw{display:flex;flex-direction:column;min-width:0}
.tn{font-size:15px;font-weight:600}
.tm,.tnote{font-size:13px;color:var(--ink-2);font-variant-numeric:tabular-nums}
.tnote{color:var(--attention-ink)}
.voided .tn{text-decoration:line-through;color:var(--ink-2)}
.pill-served{--i:var(--i-check);padding:0 2px}.pill-served::before{background:var(--accent)}
.pay{margin:4px 0 0;padding-top:12px;border-top:1px solid var(--line);font-size:13px;color:var(--ink-2)}
.confirm{--i:var(--i-ok);display:grid;grid-template-columns:20px 1fr;column-gap:10px;margin:-4px -4px 16px;padding:12px;border-radius:10px;background:var(--accent-soft)}
.confirm::before{width:20px;height:20px;margin-top:1px;background:var(--accent);grid-row:span 2}
.confirm p{margin:0}
.ct{font-size:15px;font-weight:600}
.cs{margin-top:2px!important;font-size:13px;color:var(--ink-2)}
@media (prefers-reduced-motion:no-preference){.confirm,.inorder{animation:in .2s ease-out}.order{animation:up .2s ease-out}}
@keyframes in{from{translate:0 -4px;opacity:.4}}
@keyframes up{from{translate:0 32px}}
.add{display:inline-flex;align-items:center;gap:6px;min-height:44px;padding:0 14px 0 10px;border:1px solid var(--brand);border-radius:10px;background:var(--surface);color:var(--brand);font-size:15px;font-weight:600;cursor:pointer;transition:background-color .15s ease-out;touch-action:manipulation}
.add:active{background:var(--surface-2);transform:translateY(1px)}
.inorder{--i:var(--i-check);display:inline-flex;align-items:center;gap:4px;margin-top:8px;font-size:13px;font-weight:600;color:var(--accent);font-variant-numeric:tabular-nums}
.dock{position:fixed;inset:auto 0 0;z-index:30;padding:12px 16px calc(12px + env(safe-area-inset-bottom));background:var(--bg);border-top:1px solid var(--line);box-shadow:0 -8px 24px -16px rgb(var(--shadow)/.3)}
.dock:has(>[hidden]),.order:not([hidden])~.dock{display:none}
.bar{display:flex;align-items:center;gap:12px;width:100%;max-width:38rem;min-height:52px;margin:0 auto;padding:0 16px;border:0;border-radius:10px;background:var(--brand);color:var(--brand-ink);font-size:16px;font-weight:600;text-align:left;cursor:pointer;touch-action:manipulation}
.bar:active{transform:translateY(1px)}
.count{display:inline-grid;place-items:center;min-width:26px;height:26px;padding:0 6px;border-radius:999px;background:var(--brand-ink);color:var(--brand);font-size:13px;font-variant-numeric:tabular-nums}
.bl{flex:1}
.bv{display:inline-flex;align-items:center;gap:4px;font-size:15px}
.scrim{display:none}.order:not([hidden])~.scrim{display:block}
body:has(.order:not([hidden])){overflow:hidden}
.grab{flex:none;width:36px;height:4px;margin:8px auto 0;border-radius:999px;background:var(--line)}
.shead{display:flex;align-items:baseline;justify-content:space-between;padding:12px 16px 4px}
.shead h2{margin:0;font-size:20px;font-weight:600}
.order .sheet-body{min-height:0;padding:0 16px 16px;overscroll-behavior:contain}
.cl{padding:16px 0}
.cl+.cl{border-top:1px solid var(--line)}
.ctop{display:flex;justify-content:space-between;gap:12px}
.cprice{font-weight:600;text-align:right;font-variant-numeric:tabular-nums}
.crow{display:flex;justify-content:space-between;align-items:center;margin-top:8px}
.stepper{display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:10px;background:var(--surface-2)}
.step{display:grid;place-items:center;width:44px;height:44px;border:0;background:none;color:var(--ink);font-size:20px;line-height:1;cursor:pointer;touch-action:manipulation}
.q{min-width:28px;text-align:center;font-weight:600;font-variant-numeric:tabular-nums}
.rm{--i:var(--i-trash);display:inline-flex;align-items:center;gap:6px;min-height:44px;padding:0 4px 0 8px;border:0;background:none;color:var(--ink-2);font-size:15px;cursor:pointer}
.fl{display:flex;flex-direction:column;gap:4px;margin-top:12px;font-size:13px;color:var(--ink-2)}
.fname{padding-top:16px;border-top:1px solid var(--line);font-size:15px;font-weight:600;color:var(--ink)}
.cl+.fname,#cart:empty+.fname{margin-top:8px}
.order .sheet-foot{display:block}
.order .pay{margin:0 0 12px;padding:0;border:0}
.err{margin:0 0 12px;padding:10px 12px;border-radius:10px;background:var(--attention-soft);color:var(--attention-ink);font-size:15px;font-weight:600}
.actions{display:grid;grid-template-columns:1fr 1.3fr;gap:8px}
.actions .btn{min-height:52px;font-size:16px}
.said[data-tone]{background:var(--surface-2);color:var(--ink)}`);

/**
 * The cart, the name, placing the order, and the order tracker (spec 06, steps 1,
 * 2, 3 and 5; #70, proposed, S-40). Plain DOM, no framework, so it costs about
 * 6KB on the page (spec 02's budget). The token comes from the address, the
 * session from the scan it makes on load: the page itself carries neither.
 * Everything a customer typed or a menu says is put on the page as text, never
 * as markup. The cart lives in the page only; what the phone remembers is the
 * customer's name, per session, so the next party at the table starts blank.
 * Messages go where they belong, never over the page (S-41): the order's
 * confirmation at the top of the tracker, a problem with the order inside the
 * sheet above its buttons, the waiter's answer under the header. Each row that is
 * in the cart says how many.
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
  const error = $("order-error");
  const bar = $("cart-open");
  const count = $("cart-count");
  const size = $("cart-items");
  const list = $("cart");
  const tracker = $("tracker");
  const confirmed = $("tracker-confirm");
  const waiter = $("call-waiter");
  const waiterSaid = $("waiter-status");
  const feedList = $("tracker-list");
  const feedState = $("tracker-state");
  const adds = [...document.querySelectorAll("button[data-item]")];
  const make = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const fail = (text) => { error.textContent = text; form.hidden = false; };
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
    const total = cart.reduce((sum, line) => sum + line.quantity, 0);
    bar.hidden = cart.length === 0;
    count.textContent = String(total);
    size.textContent = total + (total === 1 ? " item" : " items");
    bar.setAttribute("aria-label", "Your order, " + size.textContent);
    if (cart.length === 0) form.hidden = true;
    for (const button of adds) {
      const line = cart.find((other) => other.id === button.dataset.item);
      if (!button.mark) {
        const left = line && button.closest("li") && button.closest("li").querySelector(".left");
        if (!left) continue;
        button.mark = left.appendChild(make("span", "", "inorder ico"));
      }
      button.mark.textContent = line ? line.quantity + " in your order" : "";
    }
    list.replaceChildren(...cart.map((line) => {
      const row = make("li", undefined, "cl");
      const top = make("div", undefined, "ctop");
      top.append(make("span", line.name, "name"));
      if (line.price) top.append(make("span", line.price + (line.quantity > 1 ? " each" : ""), "cprice"));
      const change = (by, label) => {
        const button = make("button", by < 0 ? "\\u2212" : "+", "step");
        button.type = "button";
        button.setAttribute("aria-label", label + line.name);
        button.addEventListener("click", () => {
          line.quantity = Math.min(20, line.quantity + by);
          if (line.quantity < 1) cart = cart.filter((other) => other !== line);
          error.textContent = "";
          draw();
        });
        return button;
      };
      const stepper = make("div", undefined, "stepper");
      stepper.append(change(-1, "One fewer "), make("span", String(line.quantity), "q"), change(1, "One more "));
      const remove = make("button", "Remove", "rm ico");
      remove.type = "button";
      remove.addEventListener("click", () => { cart = cart.filter((other) => other !== line); error.textContent = ""; draw(); });
      const controls = make("div", undefined, "crow");
      controls.append(stepper, remove);
      const note = make("input", undefined, "input note");
      note.maxLength = 200;
      note.placeholder = "For example, no onions";
      note.value = line.note;
      note.setAttribute("aria-label", "Note for " + line.name);
      note.addEventListener("input", () => { line.note = note.value; });
      const label = make("label", undefined, "fl");
      label.append(make("span", "Kitchen note (optional)"), note);
      row.append(top, controls, label);
      return row;
    }));
  };

  const words = { placed: "Ordered", cooking: "Cooking", done: "Ready", delivered: "Served", voided: "Voided" };
  const pills = { placed: "placed", cooking: "cooking", done: "done", delivered: "served ico", voided: "voided" };
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
      if (ended) confirmed.replaceChildren();
      tracker.hidden = !shown && !confirmed.textContent;
      feedState.textContent = ended ? "This table's session has ended. Add an item to start a new one." : "";
      feedList.replaceChildren(...items.map((item) => {
        const row = make("li", undefined, item.status === "voided" ? "voided" : "");
        const what = make("div", undefined, "tw");
        what.append(make("span", times(item.quantity, item.name), "tn"), make("span", item.customer + " at " + item.time, "tm"));
        if (item.note) what.append(make("span", "Note: " + item.note, "tnote"));
        row.append(what, make("span", words[item.status] || item.status, "pill pill-" + (pills[item.status] || "neutral")));
        return row;
      }));
    } catch {} finally {
      polling = false;
      if (again) { again = false; poll(); }
    }
  };

  join().then(() => {
    for (const button of adds) button.hidden = false;
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
    else if (cart.length >= 20) return fail("An order can have up to 20 different items.");
    else cart.push({ id: button.dataset.item, name: button.dataset.name, price: button.dataset.price || "", quantity: 1, note: "" });
    error.textContent = "";
    confirmed.replaceChildren();
    draw();
    if (ended) await join().then(() => { last = ""; return poll(true); }, () => {});
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") form.hidden = true; });
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
      waiter.dataset.called = "";
      delete waiterSaid.dataset.tone;
      waiterSaid.textContent = "A waiter is on the way.";
    } catch {
      waiterSaid.dataset.tone = "error";
      waiterSaid.textContent = "That didn't go through. Check your connection and try again.";
    } finally {
      waiter.disabled = false;
    }
  });
  bar.addEventListener("click", () => { form.hidden = false; error.textContent = ""; });
  $("order-cancel").addEventListener("click", () => { form.hidden = true; });
  $("order-scrim").addEventListener("click", () => { form.hidden = true; });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = fields.name.value.trim();
    if (cart.length === 0) return;
    if (!name) return fail("Enter a name for the waiter.");
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
        error.textContent = "";
        draw();
        confirmed.replaceChildren(
          make("p", "Ordered: " + answer.placed.lines.map((line) => times(line.quantity, line.name)).join(", ") + ".", "ct"),
          make("p", "Pay at the table with your waiter as usual.", "cs"),
        );
        tracker.hidden = false;
        if (tracker.scrollIntoView) tracker.scrollIntoView({ block: "start" });
        last = "";
        poll(true);
        return;
      }
      if (answer.code === "session_changed") await join().catch(() => {});
      if (answer.code === "unavailable") {
        cart = cart.filter((line) => line.id !== answer.item);
        draw();
      }
      fail(answer.error || "That didn't go through. Try again.");
    } catch {
      fail("That didn't go through. Check your connection and try again.");
    } finally {
      fields.place.disabled = false;
    }
  });
})();`;

const orderScript = trusted(ORDER_SCRIPT);

/**
 * Under the header, on a table's page only: the waiter's answer, then the
 * table's orders, above the chips so a guest who just ordered finds them first.
 * Both stay empty and hidden until the script fills them.
 */
const trackerBlock = html`<p id="waiter-status" class="said" role="status"></p>
<section id="tracker" class="tracker" aria-live="polite" hidden><div id="tracker-confirm" class="confirm ico"></div><h2>Your table's orders</h2><p id="tracker-state" class="tstate"></p><ul id="tracker-list"></ul><p class="pay">Pay at the table with your waiter as usual.</p></section>
`;

const waiterButton = trusted(
  `<button type="button" id="call-waiter" class="waiter" hidden>${icon(BELL, "icon bell")}${icon(
    `${BELL}<path d="M22 8c0-2.3-.8-4.3-2-6"/><path d="M4 2C2.8 3.7 2 5.7 2 8"/>`,
    "icon ring",
  )}<span class="w0">Call a waiter</span><span class="w1">Waiter called</span></button>`,
);

/**
 * The sheet owns the bottom of the screen while it is open (S-41): a scrim over
 * the menu, the lines and the name scrolling, and Keep browsing and Place order
 * pinned in its own footer, so nothing can cover them. The cart bar hides.
 */
const orderBlock = html`
<style>${orderStyles}</style>
<svg hidden><symbol id="i-plus" viewBox="0 0 24 24"><path d="M5 12h14"/><path d="M12 5v14"/></symbol></svg>
<form id="order" class="sheet order" aria-label="Your order" hidden>
<div class="grab"></div>
<div class="shead"><h2>Your order</h2><span id="cart-items" class="muted"></span></div>
<div class="sheet-body"><ul id="cart"></ul>
<label class="fl fname">Name for the waiter <input name="name" maxlength="100" required autocomplete="given-name" class="input"></label></div>
<div class="sheet-foot"><p id="order-error" class="err" role="alert"></p><p class="pay">Pay at the table with your waiter as usual.</p>
<div class="actions"><button type="button" id="order-cancel" class="btn btn-secondary">Keep browsing</button><button name="place" class="btn btn-primary">Place order</button></div></div>
</form>
<div id="order-scrim" class="scrim"></div>
<div class="dock"><button type="button" id="cart-open" class="bar" hidden><span id="cart-count" class="count"></span><span class="bl">Your order</span><span class="bv">View${trusted(icon('<path d="m18 15-6-6-6 6"/>'))}</span></button></div>
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

const PLUS = trusted('<svg class="icon"><use href="#i-plus"/></svg>');

/**
 * Hidden until the script has joined the table's session: without JavaScript, or
 * with a code that no longer works, the page is the plain menu. Only on an item
 * that can be ordered now; the order endpoint checks again.
 */
const addButton = (item: Item, menu: Menu, ordering: boolean) =>
  ordering &&
  item.available &&
  html`<button type="button" class="add" data-item="${item.id}" data-name="${item.name}" data-price="${shownPrice(item, menu)}" hidden>${PLUS}Add</button>`;

/** Photo on the left; name and description, then price and Add on the right (S-41). */
const itemRow = (item: Item, menu: Menu, ordering: boolean) => html`<li${!item.available && html` class="sold-out"`}>
${thumbnail(item)}<div class="body"><div class="left"><span class="name">${item.name}${item.special && html`<em class="tag">${item.special.title ?? "Special"}</em>`}${!item.available && html`<em class="tag">Sold out</em>`}</span>${item.description && html`<p class="desc">${item.description}</p>`}</div>
<div class="right">${priceCell(item, menu)}${addButton(item, menu, ordering)}</div></div>
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
    html`<header class="head"><div class="hrow"><div><h1>${menu.restaurantName}</h1>
${menu.wifiName && html`<p class="wifi">${WIFI}Wi-Fi: ${menu.wifiName}</p>`}
${bookAgainLine(bookAgain)}</div>${ordering && waiterButton}</div></header>
${ordering && trackerBlock}${jumpBar}
<div class="sections">${specials}
${sections.length > 0 || specials ? sections : html`<p>This menu isn't up yet.</p>`}</div>`,
    ordering ? orderBlock : null,
  );
}

const noSuchMenu = page(
  "Menu not found",
  html`<header class="head"><h1>Menu not found</h1>
<p>Check the link, or ask a member of staff for the menu.</p></header>`,
);

/** A table's code that no longer leads anywhere: regenerated, archived or never made. */
const codeOutOfDate = page(
  "Code out of date",
  html`<header class="head"><h1>This code is out of date</h1>
<p>Ask a member of staff for help.</p></header>`,
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
