# 02 · Menu and Public Menu Page

**Phase 2.** This is the first thing you demo to a restaurant.

## Goal
Restaurants keep an accurate menu in USD and ZiG without any help. Customers get a fast menu page on any phone, over any connection.

## Decided
- Each item belongs to exactly one category.
- An item has a USD price, a ZiG price, or both, and needs at least one. If the ZiG price isn't fixed, it is calculated from the restaurant's current exchange rate and rounded up.
- The restaurant chooses how currencies are displayed (`currency_mode`), for example USD only, or USD with ZiG beneath it.
- Specials come in two kinds:
  - **Promotion:** an existing item at a special price, or just a badge. The item's real price never changes.
  - **Bundle:** a new item with `visibility = special_only` (for example "Burger + chips + drink"). It appears only while its special is active, and its description lists what's included.
- The generic menu QR code is view-only.

## Staff: menu editor

### Categories
- Create, rename, reorder (drag), and archive. Archiving a category requires it to be empty, or asks where its items should move.

### Items
- Fields: name, description, category, photo, price USD, price ZiG, available toggle, sort order.
- **Next to the ZiG field, show the live computed value** ("Calculated: ZiG 210 at rate 26.2") so staff can see what they'd get if they leave it blank.
- **Available toggle on the item list itself**, one tap, for "we've run out tonight." This is the action staff use most.
- Archive instead of delete.

### Photos
- Upload from a phone camera. Resize and convert to WebP on the server, at 800px for the item view and 320px for the thumbnail, aiming for under 60KB each.
- **Request size.** Vercel refuses a request body over 4.5MB, and a phone original can be larger. The editor shrinks the photo to a 1600px JPEG *(proposed)* in the browser before sending it, and the server turns that into the two WebP files. The server also refuses anything over 4MB *(proposed)*. That script is in the editor only; the public page stays script-free.
- Each upload gets a new random storage key *(proposed)*, so a replaced photo is never served from cache, and the old two files are deleted through `deleteImage`. The public page shows the 320px file at a fixed 64x64 *(proposed)* with `loading="lazy"`. The two files are named `{key}-800.webp` and `{key}-320.webp` *(proposed)*.
- The photo controls are on the item's edit form, so a photo is added once the item exists, not while adding it *(proposed)*.
- Archiving an item keeps its photo: the key and both files stay, the photo leaves the public page with the item, and it can't be changed while archived *(proposed)*.
- Storage: Cloudflare R2 on a custom domain, behind an `uploadImage` / `deleteImage` / `getUrl` interface (decided, D-07).

### Exchange rate
- One field, "1 USD = ___ ZiG", with "last updated N days ago" shown on the dashboard.
- **Warn in the staff UI when the rate is more than 7 days old** *(proposed)*, because a stale rate means every calculated price is wrong.
- Every change is a new row in `exchange_rates` (history) and an audit log entry.

### Specials
- Create a promotion by picking an item, then optionally setting a special price and a badge title, a start date, and an end date. A special needs a badge, a price, or both *(proposed)*.
- **Dates, not times** *(proposed)*. A start date opens the special at 00:00 that day in `restaurants.timezone`. An end date is included: the special runs to the end of that day, so it closes at 00:00 the day after. A blank start means it is on from the moment it is saved, and a blank end means it stays on until turned off. A blank start with an end date already past is refused, because that leaves no window. See spec 00 for the stored form.
- A special can be priced in USD, in ZiG, or both. A price in one currency discounts both (spec 00, special price precedence).
- Create a bundle in one form: it creates a `special_only` item and its special at the same time.
- Active specials list with an on/off toggle. The list shows every special of a live item that is on now or still to start, plus the 20 latest that are over or turned off, counted together, each with its dates and its state *(proposed)*. Nothing deletes a special, so without that limit the list would only grow. A special that is over simply stops showing on the page; nobody has to turn it off.
- *(Proposed, D-05)*: reject a second active special for the same item when the date ranges overlap. Postgres holds it (`specials_no_overlap`), and the form says so with a 409. Turning a special back on can be refused for the same reason. Specials that meet at midnight (one ends Sunday, the next starts Monday) don't overlap.
- Recurring specials (D-04): the columns exist, but no UI in v1.
- A special on an item that is archived afterwards stays in the table and shows nowhere: not on the page, not in the list *(proposed)*. A sold-out item with a special still shows in Specials, greyed and labelled, after the available ones *(proposed)*.
- The editor's controls for specials are owner only (S-26). Staff see none of them.
- *(Proposed)*: bundles are not built yet (they need `visibility`); this section covers promotions only.

## Customer: public menu page

**URLs:** `/m/{menu_token}` (generic QR) and `/t/{qr_token}` (table QR; see spec 03). Both render the same menu in phase 2–5.

### Layout
1. Restaurant name, plus the Wi-Fi details if set
2. **Specials** section at the top, shown only when specials are active. It lists each item on special now, with its badge and prices, and the same item stays in its own category with the same special price *(proposed)*. A special with a price but no badge is labelled "Special" *(proposed)*
3. Categories as a sticky horizontal jump bar, then items grouped by category
4. Each item shows name, description, price(s) per `currency_mode`, a lazy-loaded thumbnail, and a "Sold out" label when unavailable. Sold-out items stay visible but greyed out and sorted last *(proposed)*.

### Performance budget (decided principle, proposed numbers)
- Server-rendered HTML that works without JavaScript
- **Under 100KB before images.** Images load lazily with fixed dimensions, so the layout doesn't jump.
- Cached at the edge, revalidated when the menu changes (on-demand revalidation triggered by the editor's save) and every 5 minutes, so a special starts or ends within 5 minutes of its window (issue 24). The page decides which specials are on at the moment it is rendered, so a cached page is at most 5 minutes behind a window opening or closing. Turning a special on or off, or adding one, is a save and refreshes at once.
- Usable on throttled "Slow 3G" in Chrome DevTools within 3 seconds

To meet this, the page is a Route Handler that writes its own HTML rather than a Next.js page: S-32 in `docs/decisions.md`.

### Pricing display rules
- Show prices exactly as computed. Never show a computed ZiG price without rounding.
- `both` mode displays "$8.00 · ZiG 210". `usd_primary` displays "$8.00" with "ZiG 210" smaller underneath.
- `zig_primary` mirrors `usd_primary`: "ZiG 210" with "$8.00" smaller underneath *(proposed)*.
- A currency that can't be worked out is left out, and an item always shows a price: with no rate set yet, a USD-only item shows just its USD and a ZiG-only item just its ZiG. That holds in the single-currency modes too, so `usd_only` shows ZiG for a ZiG-only item before any rate is set, and `zig_only` shows USD for a USD-only item. Once there is a rate, a ZiG-only item's USD is calculated from it, rounded up to the USD step *(proposed)*.
- During a promotion, show the normal price struck through next to the special price. Each line is struck only if the special changes it, so a badge-only special strikes nothing, and with no rate set a line that can't be worked out is not struck *(proposed)*. Under `both` the one line is struck whole.

## Out of scope (v1)
- Modifiers and options (sizes, add-ons). Use item notes in phase 6 instead.
- Allergen and dietary tags *(revisit if venues ask)*
- Multiple languages
- Menu import from PDF or photo

## Acceptance
- [ ] Changing the exchange rate reprices every calculated ZiG item on the public page within one cache revalidation.
- [ ] A promotion shows the special price during its window and the normal price afterwards, with no manual undo.
- [ ] A bundle is invisible outside its special's window.
- [ ] The public menu page passes the performance budget on a 30-item menu with photos.
- [ ] Marking an item sold out takes one tap from the item list.
