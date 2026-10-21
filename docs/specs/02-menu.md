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
- Storage: Cloudflare R2 on a custom domain, behind an `uploadImage` / `deleteImage` / `getUrl` interface (decided, D-07).

### Exchange rate
- One field, "1 USD = ___ ZiG", with "last updated N days ago" shown on the dashboard.
- **Warn in the staff UI when the rate is more than 7 days old** *(proposed)*, because a stale rate means every calculated price is wrong.
- Every change is a new row in `exchange_rates` (history) and an audit log entry.

### Specials
- Create a promotion by picking an item, then optionally setting a special price and a badge title, a start date, and an end date.
- Create a bundle in one form: it creates a `special_only` item and its special at the same time.
- Active specials list with an on/off toggle.
- *(Proposed, D-05)*: reject a second active special for the same item when the date ranges overlap.
- Recurring specials (D-04): the columns exist, but no UI in v1.

## Customer: public menu page

**URLs:** `/m/{menu_token}` (generic QR) and `/t/{qr_token}` (table QR; see spec 03). Both render the same menu in phase 2–5.

### Layout
1. Restaurant name, plus the Wi-Fi details if set
2. **Specials** section at the top, shown only when specials are active
3. Categories as a sticky horizontal jump bar, then items grouped by category
4. Each item shows name, description, price(s) per `currency_mode`, a lazy-loaded thumbnail, and a "Sold out" label when unavailable. Sold-out items stay visible but greyed out and sorted last *(proposed)*.

### Performance budget (decided principle, proposed numbers)
- Server-rendered HTML that works without JavaScript
- **Under 100KB before images.** Images load lazily with fixed dimensions, so the layout doesn't jump.
- Cached at the edge, revalidated when the menu changes (on-demand revalidation triggered by the editor's save)
- Usable on throttled "Slow 3G" in Chrome DevTools within 3 seconds

### Pricing display rules
- Show prices exactly as computed. Never show a computed ZiG price without rounding.
- `both` mode displays "$8.00 · ZiG 210". `usd_primary` displays "$8.00" with "ZiG 210" smaller underneath.
- During a promotion, show the normal price struck through next to the special price.

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
