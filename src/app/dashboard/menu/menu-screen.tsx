import Link from "next/link";
import { Button } from "@/components/ui/button";
import { getMenu } from "@/lib/menu";
import {
  effectiveUsd,
  effectiveZig,
  formatUsd,
  formatZig,
  type Pricing,
} from "@/lib/pricing";
import { getTenantContext, requireOwner } from "@/lib/tenant";
import { ActionForm } from "../action-form";
import { Field, inputClassName } from "../field";
import { ExchangeRateStatus } from "../exchange-rate-status";
import { ItemPriceFields } from "./item-price-fields";

/**
 * The menu. Owners and staff both see the item list, because the sold-out toggle
 * is staff's most-used action (S-26). Everything that changes the menu itself
 * (adding items and categories) stays with owners, and so do its routes.
 */
export async function MenuScreen() {
  const tenant = await getTenantContext();
  const menu = await getMenu(tenant);
  const isOwner = tenant.role === "owner";

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/dashboard" className="text-sm text-muted-foreground underline">
          Back to dashboard
        </Link>
        <h1 className="font-heading text-3xl font-semibold tracking-tight">Menu</h1>
        {/* Not a Link: it's a plain HTML response, not a page of this app. */}
        <a href={`/m/${menu.menuToken}`} className="text-sm underline">
          See what customers see
        </a>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="font-heading text-xl font-semibold">Exchange rate</h2>
        <ExchangeRateStatus rate={menu.pricing.rate} setAt={menu.rateSetAt} />
        <ActionForm
          action="/api/menu/exchange-rate"
          savedMessage="Rate saved. Calculated ZiG prices are updated."
          className="flex flex-col gap-4"
        >
          <Field label="1 USD = ZiG">
            <input
              name="usdToZig"
              inputMode="decimal"
              required
              defaultValue={menu.pricing.rate ?? ""}
              className={inputClassName}
            />
          </Field>
          <Button type="submit" variant="outline" className="self-start">
            Save rate
          </Button>
        </ActionForm>
      </section>

      {menu.categories.map((category) => (
        <section key={category.id} className="flex flex-col gap-2">
          <h2 className="font-heading text-xl font-semibold">{category.name}</h2>
          {category.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing here yet.</p>
          ) : (
            <ul className="flex flex-col divide-y">
              {category.items.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-col gap-1 py-2 sm:flex-row sm:items-start sm:justify-between"
                >
                  <div className="flex flex-col">
                    <span className="flex justify-between gap-4 font-medium">
                      {item.name}
                      <ItemPrices item={item} pricing={menu.pricing} />
                    </span>
                    {item.description && (
                      <span className="text-sm text-muted-foreground">
                        {item.description}
                      </span>
                    )}
                    {!item.available && (
                      <span className="text-sm font-medium text-destructive">Sold out</span>
                    )}
                  </div>
                  <ActionForm
                    action={`/api/menu/items/${item.id}/availability`}
                    className="self-start"
                  >
                    <input
                      type="hidden"
                      name="available"
                      value={item.available ? "false" : "true"}
                    />
                    <Button type="submit" variant="outline" size="sm">
                      {item.available ? "Mark sold out" : "Mark available"}
                    </Button>
                  </ActionForm>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}

      {isOwner && (
        <section className="flex flex-col gap-3">
          <h2 className="font-heading text-xl font-semibold">Add an item</h2>
          {menu.categories.length === 0 ? (
            <p className="text-sm text-muted-foreground">Add a category first.</p>
          ) : (
            <ActionForm
              action="/api/menu/items"
              savedMessage="Item added."
              resetOnSuccess
              className="flex flex-col gap-4"
            >
              <Field label="Name">
                <input name="name" required maxLength={200} className={inputClassName} />
              </Field>
              <Field label="Description">
                <textarea
                  name="description"
                  rows={2}
                  maxLength={1000}
                  className={inputClassName}
                />
              </Field>
              <ItemPriceFields pricing={menu.pricing} />
              <Field label="Category">
                <select name="categoryId" className={inputClassName}>
                  {menu.categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Button type="submit" className="self-start">
                Add item
              </Button>
            </ActionForm>
          )}
        </section>
      )}

      {isOwner && (
        <section className="flex flex-col gap-3">
          <h2 className="font-heading text-xl font-semibold">Add a category</h2>
          <ActionForm
            action="/api/menu/categories"
            savedMessage="Category added."
            resetOnSuccess
            className="flex flex-col gap-4"
          >
            <Field label="Name">
              <input name="name" required maxLength={200} className={inputClassName} />
            </Field>
            <Button type="submit" variant="outline" className="self-start">
              Add category
            </Button>
          </ActionForm>
        </section>
      )}
    </div>
  );
}

/** Both currencies, whatever the public page shows, with the ZiG source marked. */
function ItemPrices({
  item,
  pricing,
}: {
  item: { priceUsd: string | null; priceZig: string | null };
  pricing: Pricing;
}) {
  const usd = effectiveUsd(item, pricing);
  const zig = effectiveZig(item, pricing);
  return (
    <span className="flex flex-col items-end text-right">
      {usd !== null && <span>{formatUsd(usd)}</span>}
      {zig !== null && (
        <span className="text-sm font-normal text-muted-foreground">
          {formatZig(zig.amount)}
          {zig.source === "calculated" && " (calculated)"}
        </span>
      )}
    </span>
  );
}
