"use client";

import { ChevronDown, Search } from "lucide-react";
import { createContext, type ReactNode, useContext, useState } from "react";
import { Button } from "@/components/ui/button";
import { inputClassName } from "../field";
import { cn } from "@/lib/utils";

/** Whether an item's name matches what was typed: any case, anywhere in the name. */
export function matchesQuery(name: string, query: string) {
  const wanted = query.trim().toLowerCase();
  return wanted === "" || name.toLowerCase().includes(wanted);
}

/** The folded categories once `categoryId` is open: the same set if it already was. */
export function unfolded(collapsed: ReadonlySet<string>, categoryId: string): ReadonlySet<string> {
  if (!collapsed.has(categoryId)) return collapsed;
  return new Set([...collapsed].filter((id) => id !== categoryId));
}

/** The id the jump links point at. */
export const categoryAnchor = (categoryId: string) => `category-${categoryId}`;

type Filter = {
  query: string;
  isCollapsed: (categoryId: string) => boolean;
  toggle: (categoryId: string) => void;
};

const FilterContext = createContext<Filter>({
  query: "",
  isCollapsed: () => false,
  toggle: () => {},
});

/**
 * The finder above the editor's list (#113): a search box that narrows every
 * category to the items matching, a row of jump links, and collapse all / expand
 * all. A forty-item menu is a very long page on a phone, and staff open it to
 * mark one dish sold out. Everything works as plain links without JavaScript.
 */
export function MenuFinder({
  categories,
  itemNames,
  children,
}: {
  categories: { id: string; name: string }[];
  itemNames: string[];
  children: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const searching = query.trim() !== "";
  const matches = itemNames.filter((name) => matchesQuery(name, query)).length;

  const filter: Filter = {
    query,
    isCollapsed: (id) => collapsed.has(id),
    toggle: (id) =>
      setCollapsed((now) => {
        const next = new Set(now);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
  };

  return (
    <FilterContext.Provider value={filter}>
      {itemNames.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-ink-2"
            />
            <input
              type="search"
              aria-label="Find an item"
              placeholder="Find an item"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className={cn(inputClassName, "pl-10")}
            />
          </div>
          {searching && (
            <p role="status" className="text-caption text-ink-2">
              {matches === 0
                ? "No items match."
                : `${matches} ${matches === 1 ? "item matches" : "items match"}.`}
            </p>
          )}
          {categories.length > 1 && (
            <nav aria-label="Jump to a category" className="flex items-center gap-2">
              <ul className="-mx-1 flex min-w-0 flex-1 gap-2 overflow-x-auto px-1 pb-1">
                {categories.map((category) => (
                  <li key={category.id} className="shrink-0">
                    <a
                      href={`#${categoryAnchor(category.id)}`}
                      onClick={() => setCollapsed((now) => unfolded(now, category.id))}
                      className="inline-flex h-10 items-center rounded-full border border-line bg-surface px-4 text-body font-medium text-ink outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface-2"
                    >
                      {category.name}
                    </a>
                  </li>
                ))}
              </ul>
              <Button
                type="button"
                variant="ghost"
                size="compact"
                className="shrink-0"
                onClick={() =>
                  setCollapsed(
                    collapsed.size === 0 ? new Set(categories.map((category) => category.id)) : new Set(),
                  )
                }
              >
                {collapsed.size === 0 ? "Collapse all" : "Expand all"}
              </Button>
            </nav>
          )}
        </div>
      )}
      {children}
    </FilterContext.Provider>
  );
}

/**
 * A category's item rows, with a toggle that folds them away. While searching it
 * stays open, and says so when nothing in it matches.
 */
export function ItemsBody({
  categoryId,
  names,
  children,
}: {
  categoryId: string;
  names: string[];
  children: ReactNode;
}) {
  const { query, isCollapsed, toggle } = useContext(FilterContext);
  const searching = query.trim() !== "";
  const open = searching || !isCollapsed(categoryId);
  const anyMatch = names.some((name) => matchesQuery(name, query));

  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        disabled={searching}
        onClick={() => toggle(categoryId)}
        className="flex min-h-10 w-full items-center justify-between gap-2 border-b border-line px-4 text-caption font-medium text-ink-2 outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:hover:bg-transparent"
      >
        {open ? "Hide items" : `Show ${names.length} ${names.length === 1 ? "item" : "items"}`}
        <ChevronDown aria-hidden className={cn("size-4", open && "rotate-180")} />
      </button>
      {open && searching && !anyMatch && (
        <p className="px-4 py-3 text-caption text-ink-2">No match here.</p>
      )}
      <div hidden={!open}>{children}</div>
    </>
  );
}

/** One item's row: hidden while a search doesn't match its name. */
export function FilterRow({
  name,
  className,
  children,
}: {
  name: string;
  className?: string;
  children: ReactNode;
}) {
  const { query } = useContext(FilterContext);
  return (
    <li hidden={!matchesQuery(name, query)} className={className}>
      {children}
    </li>
  );
}
