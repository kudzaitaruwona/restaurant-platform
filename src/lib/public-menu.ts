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
.order{position:fixed;inset:auto 0 0;display:flex;flex-direction:column;gap:.5rem;max-width:40rem;margin:0 auto;padding:1rem;background:Canvas;border-top:1px solid var(--line);box-shadow:0 -4px 16px rgb(0 0 0/.15)}
.order h2{margin:0;padding:0;border:0;font-size:1.1rem}
.order label{display:flex;flex-direction:column;gap:.2rem;font-size:.9rem}
.order input{padding:.5rem;border:1px solid var(--line);border-radius:.375rem;font:inherit;font-size:16px}
.order .actions{display:flex;gap:.5rem}
.order button{flex:1;padding:.6rem;border-radius:.375rem;font:inherit}
.order-status{position:fixed;inset:auto 1rem 1rem;max-width:38rem;margin:0 auto;padding:.75rem 1rem;border-radius:.375rem;background:CanvasText;color:Canvas}
.order-status:empty{display:none}`);

/**
 * The cart, the name and placing the order (spec 06, steps 1 and 2, one item).
 * Plain DOM, no framework, so it costs about 2KB on the page (spec 02's budget).
 * The token comes from the address, the session from the scan it makes on load:
 * the page itself carries neither. Everything a customer typed or a menu says is
 * put on the page as text, never as markup.
 */
const orderScript = trusted(`(() => {
  const api = (path) => "/api/t/" + encodeURIComponent(location.pathname.split("/")[2]) + path;
  const form = document.getElementById("order");
  const fields = form.elements;
  const status = document.getElementById("order-status");
  const say = (text) => { status.textContent = text; };
  let session = null;
  const nameKey = () => "order-name:" + session;
  const join = async () => {
    const response = await fetch(api("/session"), { method: "POST" });
    if (!response.ok) throw new Error(String(response.status));
    session = (await response.json()).session;
    try { fields.name.value = localStorage.getItem(nameKey()) || fields.name.value; } catch {}
  };
  join().then(() => {
    for (const button of document.querySelectorAll("button[data-item]")) button.hidden = false;
  }, () => {});
  document.addEventListener("click", (event) => {
    const button = event.target instanceof Element && event.target.closest("button[data-item]");
    if (!button) return;
    fields.item.value = button.dataset.item;
    document.getElementById("order-item").textContent = button.dataset.name;
    form.hidden = false;
    say("");
  });
  document.getElementById("order-cancel").addEventListener("click", () => { form.hidden = true; });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = new URLSearchParams(new FormData(form));
    body.set("session", session || "");
    fields.place.disabled = true;
    try {
      const response = await fetch(api("/orders"), { method: "POST", body });
      const answer = await response.json().catch(() => ({}));
      if (response.status === 201) {
        try { localStorage.setItem(nameKey(), body.get("name")); } catch {}
        form.hidden = true;
        fields.note.value = "";
        fields.quantity.value = "1";
        say("Ordered: " + answer.placed.quantity + " \u00d7 " + answer.placed.name + ". Pay at the table with your waiter as usual.");
        return;
      }
      if (answer.code === "session_changed") await join().catch(() => {});
      say(answer.error || "That didn't go through. Try again.");
    } catch {
      say("That didn't go through. Check your connection and try again.");
    } finally {
      fields.place.disabled = false;
    }
  });
})();`);

const orderBlock = html`
<style>${orderStyles}</style>
<form id="order" class="order" hidden>
<h2>Your order</h2>
<p id="order-item"></p>
<input type="hidden" name="item">
<label>Quantity <input name="quantity" type="number" inputmode="numeric" min="1" max="20" value="1" required></label>
<label>Note for the kitchen (optional) <input name="note" maxlength="200" placeholder="No onions"></label>
<label>Name for the waiter <input name="name" maxlength="100" required autocomplete="given-name"></label>
<div class="actions"><button type="button" id="order-cancel">Cancel</button><button name="place">Place order</button></div>
</form>
<p id="order-status" class="order-status" role="status"></p>
<script>${orderScript}</script>
`;

type Item = Menu["categories"][number]["items"][number];

/** The struck-through normal price, when this line has one, then the price now. */
const slot = ({ was, now }: PromotionSlot) => html`${was !== undefined && html`<s>${was}</s> `}${now}`;

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
const addButton = (item: Item, ordering: boolean) =>
  ordering &&
  item.available &&
  html`<button type="button" class="add" data-item="${item.id}" data-name="${item.name}" hidden>Add</button>`;

const itemRow = (item: Item, menu: Menu, ordering: boolean) => html`<li class="${item.available ? "" : "sold-out"}">
<div class="text">
<div class="item"><span>${item.name}${item.special && html`<em class="tag">${item.special.title ?? "Special"}</em>`}${!item.available && html`<em class="tag">Sold out</em>`}</span>${priceCell(item, menu)}</div>
${item.description && html`<p>${item.description}</p>`}${addButton(item, ordering)}
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
