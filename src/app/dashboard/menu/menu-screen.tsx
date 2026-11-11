import { Ban, ChevronUp, ExternalLink, ImageIcon, Package, Pencil, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { IconButton } from "@/components/ui/icon-button";
import { PageHeader } from "@/components/ui/page-header";
import { getMenu, type Menu } from "@/lib/menu";
import { listSpecials } from "@/lib/specials";
import { photoUrls } from "@/lib/photo-urls";
import {
  effectiveUsd,
  effectiveZig,
  formatUsd,
  formatZig,
  type Pricing,
} from "@/lib/pricing";
import { getTenantContext } from "@/lib/tenant";
import { cn } from "@/lib/utils";
import { ActionForm } from "../action-form";
import { StaffTopBarAction } from "../shell/top-bar-action";
import { SortableCategories } from "./sortable-categories";
import { Field, inputClassName } from "../field";
import { ExchangeRateStatus } from "../exchange-rate-status";
import { CategoryCard } from "./category-card";
import { Disclosure } from "./disclosure";
import { ItemPriceFields } from "./item-price-fields";
import { Pill } from "./pill";
import { SpecialsSection } from "./specials-section";
import { PhotoForm } from "./photo-form";

/**
 * The menu. Owners and staff both see the item list, because the sold-out toggle
 * is staff's most-used action (S-26). That toggle is all staff get here: the
 * exchange rate, every add, edit, reorder and archive control, and the photo form
 * render for owners only, and their routes refuse anyone else.
 *
 * Layout (S-41): the categories as cards of item rows; for owners, a side column
 * (under the list on narrow screens) with the rate, the add forms and specials.
 */
export async function MenuScreen() {
  const tenant = await getTenantContext();
  const isOwner = tenant.role === "owner";
  const [menu, specials] = await Promise.all([
    getMenu(tenant, new Date(), { forEditor: true }),
    isOwner ? listSpecials(tenant) : [],
  ]);
  const canAddItem = isOwner && menu.categories.length > 0;
  const sections = menu.categories.map((category) => ({
    id: category.id,
    name: category.name,
    head: <CategoryHead category={category} isOwner={isOwner} />,
    foot: isOwner ? (
      <ArchiveCategory
        category={category}
        others={menu.categories.filter((other) => other.id !== category.id)}
      />
    ) : undefined,
    content: (
      <CategoryItems category={category} all={menu.categories} pricing={menu.pricing} isOwner={isOwner} />
    ),
  }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Menu"
        subtitle={
          isOwner
            ? "Categories, items and prices, as customers see them."
            : "Mark an item sold out the moment it runs out."
        }
        actions={
          <>
            {/* Not a Link: it's a plain HTML response, not a page of this app. */}
            <a
              href={`/m/${menu.menuToken}`}
              className={cn(buttonVariants({ variant: "secondary", size: "staff" }))}
            >
              <ExternalLink aria-hidden />
              See what customers see
            </a>
            {canAddItem && (
              <a
                href="#add-item"
                className={cn(buttonVariants({ variant: "primary", size: "staff" }), "hidden md:inline-flex")}
              >
                <Plus aria-hidden />
                Add item
              </a>
            )}
          </>
        }
      />
      {canAddItem && (
        <StaffTopBarAction>
          <IconButton label="Add item" icon={<Plus />} href="#add-item" variant="ghost" />
        </StaffTopBarAction>
      )}

      <div
        className={cn(
          "grid gap-6",
          isOwner ? "lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start" : "max-w-3xl",
        )}
      >
        <div className="flex min-w-0 flex-col gap-4">
          {sections.length === 0 ? (
            <Card className="flex flex-col items-start gap-1 px-5 py-8">
              <p className="text-lead font-semibold">No categories yet</p>
              <p className="text-ink-2">
                {isOwner
                  ? "Start with a category, like Starters or Mains, then add its items."
                  : "The owner hasn't added anything to the menu."}
              </p>
            </Card>
          ) : isOwner ? (
            <SortableCategories entries={sections} />
          ) : (
            sections.map((section) => (
              <CategoryCard key={section.id} head={section.head}>
                {section.content}
              </CategoryCard>
            ))
          )}
        </div>

        {isOwner && (
          <aside className="flex min-w-0 flex-col gap-4">
            <SideCard title="Exchange rate">
              <ExchangeRateStatus rate={menu.pricing.rate} setAt={menu.rateSetAt} />
              <ActionForm
                action="/api/menu/exchange-rate"
                savedMessage="Rate saved. Calculated ZiG prices are updated."
                className="flex flex-col gap-2"
              >
                <div className="flex items-end gap-2">
                  <Field label="1 USD = ZiG" className="flex-1">
                    <input
                      name="usdToZig"
                      inputMode="decimal"
                      required
                      defaultValue={menu.pricing.rate ?? ""}
                      className={`${inputClassName} tabular-nums`}
                    />
                  </Field>
                  <Button type="submit" variant="secondary" size="staff">
                    Save rate
                  </Button>
                </div>
              </ActionForm>
            </SideCard>

            <SideCard title="Add an item" id="add-item">
              {menu.categories.length === 0 ? (
                <p className="text-ink-2">Add a category first.</p>
              ) : (
                <ActionForm
                  action="/api/menu/items"
                  savedMessage="Item added."
                  resetOnSuccess
                  className="@container flex flex-col gap-4"
                >
                  <Field label="Name">
                    <input name="name" required maxLength={200} className={inputClassName} />
                  </Field>
                  <Field label="Description">
                    <textarea
                      name="description"
                      rows={2}
                      maxLength={1000}
                      className={cn(inputClassName, "min-h-20 resize-y")}
                    />
                  </Field>
                  <ItemPriceFields pricing={menu.pricing} />
                  <Field label="Category">
                    <CategorySelect categories={menu.categories} />
                  </Field>
                  <Button type="submit" size="staff" className="self-start">
                    Add item
                  </Button>
                </ActionForm>
              )}
            </SideCard>

            <SideCard title="Add a category">
              <ActionForm
                action="/api/menu/categories"
                savedMessage="Category added."
                resetOnSuccess
                className="flex flex-col gap-2"
              >
                <div className="flex items-end gap-2">
                  <Field label="Name" className="flex-1">
                    <input name="name" required maxLength={200} className={inputClassName} />
                  </Field>
                  <Button type="submit" variant="secondary" size="staff">
                    Add category
                  </Button>
                </div>
              </ActionForm>
            </SideCard>

            <SpecialsSection
              specials={specials}
              items={menu.categories.flatMap((category) => category.items)}
              timezone={menu.timezone}
            />

            <BundleForm categories={menu.categories} pricing={menu.pricing} timezone={menu.timezone} />
          </aside>
        )}
      </div>
    </div>
  );
}

/** A card in the owner's side column, with a 17px heading. */
function SideCard({ title, id, children }: { title: string; id?: string; children: ReactNode }) {
  return (
    <Card as="section" id={id} className="flex scroll-mt-20 flex-col gap-3 p-4 sm:p-5">
      <h2 className="text-lead font-semibold">{title}</h2>
      {children}
    </Card>
  );
}

function CategorySelect({ categories, defaultValue }: { categories: Category[]; defaultValue?: string }) {
  return (
    <select name="categoryId" defaultValue={defaultValue} className={inputClassName}>
      {categories.map((category) => (
        <option key={category.id} value={category.id}>
          {category.name}
        </option>
      ))}
    </select>
  );
}

/**
 * A bundle and its special in one form (spec 02 › Specials). Owners only (S-26):
 * the caller renders it for no one else, and the route refuses staff.
 */
function BundleForm({
  categories,
  pricing,
  timezone,
}: {
  categories: Category[];
  pricing: Pricing;
  timezone: string;
}) {
  return (
    <Card as="section" className="px-4 py-1 sm:px-5">
      <Disclosure title="Add a bundle">
        {categories.length === 0 ? (
          <p className="text-ink-2">Add a category first.</p>
        ) : (
          <ActionForm
            action="/api/menu/bundles"
            savedMessage="Bundle added."
            resetOnSuccess
            className="@container flex flex-col gap-4"
          >
            <p className="text-caption text-ink-2">
              Customers see a bundle only while its special is on, in the Specials section.
            </p>
            <Field label="Name">
              <input name="name" required maxLength={200} className={inputClassName} />
            </Field>
            <Field label="What's included">
              <textarea
                name="description"
                rows={2}
                required
                maxLength={1000}
                className={cn(inputClassName, "min-h-20 resize-y")}
              />
            </Field>
            <ItemPriceFields pricing={pricing} />
            <Field label="Category" hint="Where it sits in this editor. Customers don't see it there.">
              <CategorySelect categories={categories} />
            </Field>
            <Field label="Badge" hint={`Optional. Shows as "Bundle" if blank.`}>
              <input name="title" maxLength={80} className={inputClassName} />
            </Field>
            <Field label="First day" hint={`Optional. Dates are in ${timezone} time.`}>
              <input name="startDate" type="date" className={inputClassName} />
            </Field>
            <Field
              label="Last day"
              hint="Optional, and included. Leave blank to keep it on until you turn its special off."
            >
              <input name="endDate" type="date" className={inputClassName} />
            </Field>
            <Button type="submit" size="staff" className="self-start">
              Add bundle
            </Button>
          </ActionForm>
        )}
      </Disclosure>
    </Card>
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
    <span className="flex flex-wrap items-baseline gap-x-2 tabular-nums @lg:flex-col @lg:items-end @lg:pt-1.5 @lg:text-right">
      {usd !== null && <span className="text-lead font-semibold">{formatUsd(usd)}</span>}
      {zig !== null && (
        <span className="text-caption text-ink-2">
          {formatZig(zig.amount)}
          {zig.source === "calculated" && " (calculated)"}
        </span>
      )}
    </span>
  );
}

type Category = Menu["categories"][number];

/** The category's name, or for owners the form that renames it, and its count. */
function CategoryHead({ category, isOwner }: { category: Category; isOwner: boolean }) {
  const count = (
    <span className="shrink-0 text-caption text-ink-2 tabular-nums">
      {category.items.length} {category.items.length === 1 ? "item" : "items"}
    </span>
  );
  if (!isOwner) {
    return (
      <div className="flex min-h-10 items-center justify-between gap-3">
        <h2 className="text-title font-semibold">{category.name}</h2>
        {count}
      </div>
    );
  }
  return (
    <ActionForm
      action={`/api/menu/categories/${category.id}`}
      savedMessage="Renamed."
      className="flex flex-col gap-1"
    >
      <div className="flex items-center gap-2">
        <label className="min-w-0 flex-1">
          <span className="sr-only">Category name</span>
          <input
            name="name"
            defaultValue={category.name}
            required
            maxLength={200}
            className={cn(
              inputClassName,
              "min-h-10 border-transparent bg-transparent px-2 py-1 text-title font-semibold hover:border-line focus:bg-surface",
            )}
          />
        </label>
        <span className="hidden sm:inline">{count}</span>
        <Button type="submit" variant="ghost" size="compact">
          Rename
        </Button>
      </div>
    </ActionForm>
  );
}

function CategoryItems({
  category,
  all,
  pricing,
  isOwner,
}: {
  category: Category;
  all: Category[];
  pricing: Pricing;
  isOwner: boolean;
}) {
  if (category.items.length === 0) {
    return <p className="px-4 py-5 text-ink-2">Nothing here yet.</p>;
  }
  return (
    <ul className="@container divide-y divide-line">
      {category.items.map((item) => {
        const thumb = item.photoKey ? photoUrls(item.photoKey).thumb : null;
        return (
          <li key={item.id} className="relative px-4 py-3">
            <div
              className={cn(
                "grid grid-cols-[48px_minmax(0,1fr)] items-start gap-x-3 gap-y-2 @lg:grid-cols-[48px_minmax(0,1fr)_auto_auto] @lg:gap-x-4",
                isOwner && "@lg:pr-12",
              )}
            >
              {thumb ? (
                // eslint-disable-next-line @next/next/no-img-element -- already a 320px WebP on the CDN
                <img
                  src={thumb}
                  alt=""
                  width={64}
                  height={64}
                  loading="lazy"
                  className={cn(
                    "row-span-3 size-12 rounded-control bg-surface-2 object-cover @lg:row-span-1",
                    !item.available && "opacity-50 grayscale",
                  )}
                />
              ) : (
                <span
                  aria-hidden
                  className="row-span-3 flex size-12 items-center justify-center rounded-control bg-surface-2 text-ink-2 @lg:row-span-1 [&_svg]:size-5 [&_svg]:opacity-60"
                >
                  <ImageIcon strokeWidth={1.5} />
                </span>
              )}
              <div className={cn("flex min-w-0 flex-col gap-0.5 pt-1", isOwner && "pr-12 @lg:pr-0")}>
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className={cn("text-lead font-semibold", !item.available && "text-ink-2")}>
                    {item.name}
                  </span>
                  {item.visibility === "special_only" && (
                    <Pill icon={<Package aria-hidden />}>Bundle</Pill>
                  )}
                  {!item.available && (
                    <Pill tone="muted" icon={<Ban aria-hidden />}>
                      Sold out
                    </Pill>
                  )}
                </p>
                {item.description && (
                  <p className="line-clamp-2 text-caption text-ink-2">{item.description}</p>
                )}
                {item.visibility === "special_only" && !item.special && (
                  <p className="text-caption text-ink-2">
                    Not on the menu now: customers see a bundle only while its special is on.
                  </p>
                )}
              </div>
              <ItemPrices item={item} pricing={pricing} />
              <ActionForm
                action={`/api/menu/items/${item.id}/availability`}
                className="flex flex-col items-start gap-1 @lg:items-end"
              >
                <input
                  type="hidden"
                  name="available"
                  value={item.available ? "false" : "true"}
                />
                <Button
                  type="submit"
                  variant={item.available ? "secondary" : "soft"}
                  size="compact"
                  className="min-w-36"
                >
                  {item.available ? "Mark sold out" : "Mark available"}
                </Button>
              </ActionForm>
            </div>
            {isOwner && <ItemEditor item={item} categories={all} pricing={pricing} />}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The item's editor, a disclosure under its row. Its button sits in the row's
 * top right corner; the form opens full width below. A <details>, so it opens
 * without JavaScript.
 */
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
    <details className="group">
      <summary
        title={`Edit ${item.name}`}
        className={cn(buttonVariants({
          variant: "ghost",
          size: "compact",
          className:
            "absolute top-3 right-3 size-10 cursor-pointer list-none px-0 group-open:bg-surface-2 [&::-webkit-details-marker]:hidden",
        }))}
      >
        <span className="sr-only">Edit</span>
        <Pencil aria-hidden className="group-open:hidden" />
        <ChevronUp aria-hidden className="hidden group-open:block" />
      </summary>
      <div className="mt-3 flex flex-col gap-5 rounded-card border border-line bg-page p-4 sm:p-5">
        <PhotoForm
          itemId={item.id}
          itemName={item.name}
          thumbUrl={item.photoKey ? photoUrls(item.photoKey).thumb : null}
        />
        <ActionForm
          action={`/api/menu/items/${item.id}`}
          savedMessage="Saved."
          className="@container flex flex-col gap-4"
        >
          <div className="grid gap-4 @md:grid-cols-[minmax(0,1fr)_minmax(0,14rem)]">
            <Field label="Name">
              <input name="name" defaultValue={item.name} required maxLength={200} className={inputClassName} />
            </Field>
            <Field label="Category">
              <CategorySelect categories={categories} defaultValue={item.categoryId} />
            </Field>
          </div>
          <Field label="Description">
            <textarea
              name="description"
              defaultValue={item.description}
              rows={2}
              maxLength={1000}
              required={item.visibility === "special_only"}
              className={cn(inputClassName, "min-h-20 resize-y")}
            />
          </Field>
          <ItemPriceFields pricing={pricing} saved={item} />
          <Field label="Sort order" hint="Lower numbers come first." className="max-w-48">
            <input
              name="sortOrder"
              defaultValue={item.sortOrder}
              inputMode="numeric"
              required
              className={`${inputClassName} tabular-nums`}
            />
          </Field>
          <Button type="submit" size="staff" className="self-start">
            Save item
          </Button>
        </ActionForm>
        <div className="border-t border-line pt-4">
          <ActionForm
            action={`/api/menu/items/${item.id}/archive`}
            confirmation={`Archive ${item.name}? Customers will stop seeing it.`}
            className="flex flex-col items-start gap-1"
          >
            <Button type="submit" variant="danger-secondary" size="compact">
              Archive item
            </Button>
          </ActionForm>
        </div>
      </div>
    </details>
  );
}

/** Empty: just archive. Otherwise the items have to go somewhere (spec 02). */
function ArchiveCategory({ category, others }: { category: Category; others: Category[] }) {
  const hasItems = category.items.length > 0;
  if (hasItems && others.length === 0) {
    return (
      <p className="text-caption text-ink-2">
        Add another category before archiving this one, so its items have somewhere to go.
      </p>
    );
  }
  return (
    <ActionForm
      action={`/api/menu/categories/${category.id}/archive`}
      confirmation={`Archive ${category.name}? Customers will stop seeing it.`}
      className="flex flex-col gap-1"
    >
      <div className="flex flex-wrap items-end gap-2">
        {hasItems && (
          <Field label="Move its items to" className="w-full max-w-56">
            <select name="moveItemsTo" required className={cn(inputClassName, "min-h-10 py-2")}>
              {others.map((other) => (
                <option key={other.id} value={other.id}>
                  {other.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Button type="submit" variant="danger-ghost" size="compact">
          Archive category
        </Button>
      </div>
    </ActionForm>
  );
}
