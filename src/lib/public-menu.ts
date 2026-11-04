import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { html, trusted } from "@/lib/html";
import { getMenu, type Menu } from "@/lib/menu";
import { menuTag } from "@/lib/menu-cache";
import { photoUrls } from "@/lib/photo-urls";
import { type PromotionSlot, priceDisplay, promotionDisplay } from "@/lib/pricing";
import { type PublicTokenKind, resolvePublicToken } from "@/lib/tenant/public";

/**
 * The customer's menu page (spec 02), shared by every public URL that shows it.
 * Written as a string because an App Router page can't leave out the framework's
 * scripts, which alone break the budget (S-32). The whole of it is below: no
 * JavaScript, no web fonts, one inline stylesheet, so one request draws the page.
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
h1{margin:0 0 1rem;font-size:1.75rem;line-height:1.2}
h2{margin:2rem 0 0;padding-bottom:.25rem;border-bottom:1px solid var(--line);font-size:1.25rem}
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

const page = (title: string, body: ReturnType<typeof html>) =>
  html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${stylesheet}</style>
</head>
<body><main>${body}</main></body>
</html>
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

const itemRow = (item: Item, menu: Menu) => html`<li class="${item.available ? "" : "sold-out"}">
<div class="text">
<div class="item"><span>${item.name}${item.special && html`<em class="tag">${item.special.title ?? "Special"}</em>`}${!item.available && html`<em class="tag">Sold out</em>`}</span>${priceCell(item, menu)}</div>
${item.description && html`<p>${item.description}</p>`}
</div>
${thumbnail(item)}
</li>`;

/** Sold-out items stay on the page, after the rest of their category (spec 02). */
const availableFirst = (items: Item[]) =>
  [...items].sort((a, b) => Number(!a.available) - Number(!b.available));

/**
 * Whatever is on special now, at the top (spec 02). Each item is also in its own
 * category, with the same price, so the two never disagree.
 */
function specialsSection(menu: Menu) {
  const onSpecial = availableFirst(
    menu.categories.flatMap((category) => category.items).filter((item) => item.special),
  );
  if (onSpecial.length === 0) return null;
  return html`<section id="specials">
<h2>Specials</h2>
<ul>${onSpecial.map((item) => itemRow(item, menu))}</ul>
</section>`;
}

function menuPage(menu: Menu) {
  const sections = menu.categories
    .filter((category) => category.items.length > 0)
    .map(
      (category) => html`<section>
<h2>${category.name}</h2>
<ul>${availableFirst(category.items).map((item) => itemRow(item, menu))}</ul>
</section>`,
    );

  return page(
    menu.restaurantName,
    html`<h1>${menu.restaurantName}</h1>
${specialsSection(menu)}
${sections.length > 0 ? sections : html`<p>This menu isn't up yet.</p>`}`,
  );
}

const noSuchMenu = page(
  "Menu not found",
  html`<h1>Menu not found</h1>
<p>Check the link, or ask a member of staff for the menu.</p>`,
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
  return menuPage(await getMenu(tenant)).toString();
}

export async function publicMenuResponse(kind: PublicTokenKind, token: string) {
  const menu = await cachedPage(kind, token);
  return new Response(menu ?? noSuchMenu.toString(), {
    status: menu === null ? 404 : 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
