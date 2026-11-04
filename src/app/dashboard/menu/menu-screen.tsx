import Link from "next/link";
import { Button } from "@/components/ui/button";
import { formatUsd, getMenu, type Menu } from "@/lib/menu";
import { getTenantContext, requireOwner } from "@/lib/tenant";
import { ActionForm } from "../action-form";
import { SortableCategories } from "./sortable-categories";
import { Field, inputClassName } from "../field";

/**
 * The menu editor: owner only (S-26). The sold-out toggle, for staff too, will
 * need this screen opened to them with everything else on it still held back.
 */
export async function MenuScreen() {
  const tenant = await getTenantContext();
  requireOwner(tenant);
  const menu = await getMenu(tenant);

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

      <SortableCategories
        entries={menu.categories.map((category) => ({
          id: category.id,
          name: category.name,
          content: (
            <CategorySection
              category={category}
              others={menu.categories.filter((other) => other.id !== category.id)}
              all={menu.categories}
            />
          ),
        }))}
      />

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
            <Field label="Price (USD)">
              <input
                name="priceUsd"
                inputMode="decimal"
                required
                className={inputClassName}
              />
            </Field>
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
    </div>
  );
}

type Category = Menu["categories"][number];

function CategorySection({
  category,
  others,
  all,
}: {
  category: Category;
  others: Category[];
  all: Category[];
}) {
  return (
    <section className="flex flex-col gap-2">
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

      {category.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing here yet.</p>
      ) : (
        <ul className="flex flex-col divide-y">
          {category.items.map((item) => (
            <li key={item.id} className="flex flex-col py-2">
              <span className="flex justify-between gap-4 font-medium">
                {item.name}
                {item.priceUsd !== null && <span>{formatUsd(item.priceUsd)}</span>}
              </span>
              {item.description && (
                <span className="text-sm text-muted-foreground">{item.description}</span>
              )}
              <ItemEditor item={item} categories={all} />
            </li>
          ))}
        </ul>
      )}

      <ArchiveCategory category={category} others={others} />
    </section>
  );
}

function ItemEditor({
  item,
  categories,
}: {
  item: Category["items"][number];
  categories: Category[];
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
          <Field label="Price (USD)">
            <input name="priceUsd" defaultValue={item.priceUsd ?? ""} inputMode="decimal" className={inputClassName} />
          </Field>
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
