"use client";

import { ChevronDown } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { cardClassName } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { easeOut } from "../motion";

export type RestaurantListItem = {
  id: string;
  name: string;
  /** Everything a search can find it by, lowercase: name, public address, owners. */
  searchText: string;
  /** Always visible: who it is, where it stands, the way in. */
  summary: ReactNode;
  /** Owner, numbers and checklist: shown when the card is open. */
  details: ReactNode;
};

const matches = (item: RestaurantListItem, words: string[]) =>
  words.every((word) => item.searchText.includes(word));

/**
 * /admin's restaurants, searchable and collapsible (spec 01): with a few dozen
 * restaurants a page of fully open cards is a long scroll. Each card keeps its
 * summary on show and opens to its details. Closed and filtered-out content stays
 * in the page, only hidden, so the server renders it once and nothing is fetched
 * on open.
 */
export function RestaurantList({ items }: { items: RestaurantListItem[] }) {
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = items.filter((item) => matches(item, words));
  const allOpen = shown.length > 0 && shown.every((item) => open.has(item.id));

  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1 basis-64 sm:max-w-md">
          <label htmlFor={searchId} className="sr-only">
            Search restaurants
          </label>
          <Input
            id={searchId}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search by name, address or owner"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <Button
          type="button"
          variant="secondary"
          size="compact"
          disabled={shown.length === 0}
          onClick={() =>
            setOpen((current) => {
              const next = new Set(current);
              for (const item of shown) {
                if (allOpen) next.delete(item.id);
                else next.add(item.id);
              }
              return next;
            })
          }
        >
          {allOpen ? "Collapse all" : "Expand all"}
        </Button>
        <p role="status" className="text-caption text-ink-2 tabular-nums">
          {words.length === 0
            ? null
            : shown.length === 0
              ? "No restaurant matches that."
              : `${shown.length} of ${items.length} shown`}
        </p>
      </div>

      <ul aria-label="Restaurants" className="flex flex-col gap-3">
        {items.map((item) => {
          const isOpen = open.has(item.id);
          const detailsId = `restaurant-${item.id}`;
          return (
            <li
              key={item.id}
              hidden={!matches(item, words)}
              className={cn(cardClassName, "overflow-hidden")}
            >
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 p-4 md:px-5">
                {item.summary}
              </div>
              <button
                type="button"
                aria-expanded={isOpen}
                aria-controls={detailsId}
                onClick={() => toggle(item.id)}
                className="flex min-h-11 w-full items-center justify-between gap-2 border-t border-line px-4 text-caption font-medium text-ink-2 outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring md:px-5"
              >
                {isOpen ? "Hide details" : "Show owner, bookings and setup"}
                <ChevronDown
                  aria-hidden
                  strokeWidth={1.75}
                  className={cn(
                    "size-4 transition-transform duration-200 motion-reduce:transition-none",
                    easeOut,
                    isOpen && "rotate-180",
                  )}
                />
              </button>
              <div hidden={!isOpen} id={detailsId}>
                {item.details}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
