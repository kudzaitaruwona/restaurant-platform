"use client";

import { useState } from "react";
import { Select } from "@/components/ui/input";
import { effectiveUsd, effectiveZig, formatUsd, formatZig, type Pricing } from "@/lib/pricing";
import { Field } from "../field";

export type PickableItem = {
  id: string;
  name: string;
  category: string;
  priceUsd: string | null;
  priceZig: string | null;
  bundle: boolean;
};

/** "$19.50 · ZiG 511 (calculated)": what the item costs now, in both currencies. */
export function normalPriceLabel(item: PickableItem, pricing: Pricing) {
  const usd = effectiveUsd(item, pricing);
  const zig = effectiveZig(item, pricing);
  return (
    [
      usd !== null && formatUsd(usd),
      zig !== null && `${formatZig(zig.amount)}${zig.source === "calculated" ? " (calculated)" : ""}`,
    ]
      .filter(Boolean)
      .join(" · ") || "No price"
  );
}

/**
 * The special form's item choice. Two items can share a name across categories
 * (or by mistake within one), so each option carries its category and USD price,
 * and the chosen item's normal price is shown under it: the special has to be
 * lower, and the owner can't see that without it.
 */
export function SpecialItemPicker({ items, pricing }: { items: PickableItem[]; pricing: Pricing }) {
  const [chosen, setChosen] = useState(items[0]?.id);
  const item = items.find(({ id }) => id === chosen) ?? items[0];
  return (
    <Field
      label="Item"
      hint={item && <span role="status">Normal price: {normalPriceLabel(item, pricing)}</span>}
    >
      <Select name="menuItemId" value={item?.id} onChange={(event) => setChosen(event.target.value)}>
        {items.map((option) => {
          const usd = effectiveUsd(option, pricing);
          return (
            <option key={option.id} value={option.id}>
              {option.name}
              {option.bundle ? " (bundle)" : ""} · {option.category}
              {usd !== null ? ` · ${formatUsd(usd)}` : ""}
            </option>
          );
        })}
      </Select>
    </Field>
  );
}
