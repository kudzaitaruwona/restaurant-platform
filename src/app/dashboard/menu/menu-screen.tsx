import Link from "next/link";
import { Fragment } from "react";
import { Button } from "@/components/ui/button";
import { getMenu, type Menu } from "@/lib/menu";
import { photoUrls } from "@/lib/photo-urls";
import {
  effectiveUsd,
  effectiveZig,
  formatUsd,
  formatZig,
  type Pricing,
} from "@/lib/pricing";
import { getTenantContext } from "@/lib/tenant";
import { ActionForm } from "../action-form";
import { SortableCategories } from "./sortable-categories";
import { Field, inputClassName } from "../field";
import { ExchangeRateStatus } from "../exchange-rate-status";
import { ItemPriceFields } from "./item-price-fields";
import { PhotoForm } from "./photo-form";

/**
 * The menu. Owners and staff both see the item list, because the sold-out toggle
 * is staff's most-used action (S-26). That toggle is all staff get here: the
 * exchange rate, every add, edit, reorder and archive control, and the photo form
 * render for owners only, and their routes refuse anyone else.
 */
export async function MenuScreen() {
  const tenant = await getTenantContext();
  const menu = await getMenu(tenant);
  const isOwner = tenant.role === "owner";
  const sections = menu.categories.map((category) => ({
    id: category.id,
    name: category.name,
    content: (
      <CategorySection
        category={category}
        others={menu.categories.filter((other) => other.id !== category.id)}
        all={menu.categories}
        pricing={menu.pricing}
        isOwner={isOwner}
      />
    ),
  }));

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

      {isOwner && (
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
      )}

      {isOwner ? (
        <SortableCategories entries={sections} />
      ) : (
        <div className="flex flex-col gap-6">
          {sections.map((section) => (
            <Fragment key={section.id}>{section.content}</Fragment>
          ))}
        </div>
      )}

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

type Category = Menu["categories"][number];

function CategorySection({
  category,
  others,
  all,
  pricing,
  isOwner,
}: {
  category: Category;
  others: Category[];
  all: Category[];
  pricing: Pricing;
  isOwner: boolean;
}) {
  return (
    <section className="flex flex-col gap-2">
      {isOwner ? (
        <ActionForm
          action={`/api/menu/categories/${category.id}`}
          savedMessage="Renamed."
          className="flex items-end gap-2"
        >
          <label className="flex flex-1 flex-col gap-1 text-sm font-medium">
            <span className="sr-only">Category name</span>
            <input
              name="name"
              defaultValue={category.name}
              required
              maxLength={200}
              className={`${inputClassName} font-heading text-xl font-semibold`}
            />
          </label>
          <Button type="submit" variant="outline">
            Rename
          </Button>
        </ActionForm>
      ) : (
        <h2 className="font-heading text-xl font-semibold">{category.name}</h2>
      )}

      {category.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing here yet.</p>
      ) : (
        <ul className="flex flex-col divide-y">
          {category.items.map((item) => (
            <li key={item.id} className="flex flex-col gap-1 py-2">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex flex-col">
                  <span className="flex justify-between gap-4 font-medium">
                    {item.name}
                    <ItemPrices item={item} pricing={pricing} />
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
              </div>
              {isOwner && (
                <>
                  <PhotoForm
                    itemId={item.id}
                    itemName={item.name}
                    thumbUrl={item.photoKey ? photoUrls(item.photoKey).thumb : null}
                  />
                  <ItemEditor item={item} categories={all} pricing={pricing} />
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {isOwner && <ArchiveCategory category={category} others={others} />}
    </section>
  );
}

function ItemEditor({
  item,
  categories,
  pricing,
}: {
  item: Category["items"][number];
  categories: Category[];
  pricing: Pricing;
}) {
  return (
    <details className="mt-1 text-sm">
      <summary className="cursor-pointer text-muted-foreground underline">Edit</summary>
      <div className="mt-2 flex flex-col gap-3">
        <ActionForm
          action={`/api/menu/items/${item.id}`}
          savedMessage="Saved."
          className="flex flex-col gap-3"
        >
          <Field label="Name">
            <input name="name" defaultValue={item.name} required maxLength={200} className={inputClassName} />
          </Field>
          <Field label="Description">
            <textarea name="description" defaultValue={item.description} rows={2} maxLength={1000} className={inputClassName} />
          </Field>
          <ItemPriceFields pricing={pricing} saved={item} />
          <Field label="Category">
            <select name="categoryId" defaultValue={item.categoryId} className={inputClassName}>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Sort order" hint="Lower numbers come first.">
            <input name="sortOrder" defaultValue={item.sortOrder} inputMode="numeric" required className={inputClassName} />
          </Field>
          <Button type="submit" className="self-start">
            Save item
          </Button>
        </ActionForm>
        <ActionForm
          action={`/api/menu/items/${item.id}/archive`}
          confirmation={`Archive ${item.name}? Customers will stop seeing it.`}
        >
          <Button type="submit" variant="outline">
            Archive item
          </Button>
        </ActionForm>
      </div>
    </details>
  );
}

/** Empty: just archive. Otherwise the items have to go somewhere (spec 02). */
function ArchiveCategory({ category, others }: { category: Category; others: Category[] }) {
  const hasItems = category.items.length > 0;
  if (hasItems && others.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Add another category before archiving this one, so its items have somewhere to go.
      </p>
    );
  }
  return (
    <ActionForm
      action={`/api/menu/categories/${category.id}/archive`}
      confirmation={`Archive ${category.name}? Customers will stop seeing it.`}
      className="flex flex-wrap items-end gap-2"
    >
      {hasItems && (
        <Field label="Move its items to">
          <select name="moveItemsTo" required className={inputClassName}>
            {others.map((other) => (
              <option key={other.id} value={other.id}>
                {other.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Button type="submit" variant="outline">
        Archive category
      </Button>
    </ActionForm>
  );
}
