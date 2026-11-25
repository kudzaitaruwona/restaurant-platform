"use client";

import { useEffect, useRef, useState } from "react";
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
 * What each option reads: "Soda · Drinks · $1.00 · ZiG 30 (calculated)". Items
 * that still read the same (a duplicate the owner confirmed) are numbered in menu
 * order, "· 1 of 2".
 */
function optionLabels(items: PickableItem[], pricing: Pricing) {
  const labels = items.map(
    (item) =>
      `${item.name}${item.bundle ? " (bundle)" : ""} · ${item.category} · ${normalPriceLabel(item, pricing)}`,
  );
  const total = new Map<string, number>();
  for (const label of labels) total.set(label, (total.get(label) ?? 0) + 1);
  const seen = new Map<string, number>();
  return labels.map((label) => {
    const of = total.get(label)!;
    if (of === 1) return label;
    const number = (seen.get(label) ?? 0) + 1;
    seen.set(label, number);
    return `${label} · ${number} of ${of}`;
  });
}

/**
 * The special form's item choice. Two items can share a name across categories
 * (or by mistake within one), so each option carries its category and normal
 * price, and the chosen item's normal price is shown under it: the special has to
 * be lower, and the owner can't see that without it.
 */
export function SpecialItemPicker({ items, pricing }: { items: PickableItem[]; pricing: Pricing }) {
  const [chosen, setChosen] = useState<string | undefined>(items[0]?.id);
  const [resets, setResets] = useState(0);
  const hint = useRef<HTMLSpanElement>(null);

  // A reset puts the browser's select back without telling React, so the normal
  // price would stay the old item's. Start the choice over instead.
  useEffect(() => {
    const form = hint.current?.closest("form");
    if (!form) return;
    const startOver = () => {
      setChosen(undefined);
      setResets((count) => count + 1);
    };
    form.addEventListener("reset", startOver);
    return () => form.removeEventListener("reset", startOver);
  }, []);

  const labels = optionLabels(items, pricing);
  const item = items.find(({ id }) => id === chosen) ?? items[0];
  return (
    <Field
      label="Item"
      hint={item && <span ref={hint} role="status">Normal price: {normalPriceLabel(item, pricing)}</span>}
    >
      <Select
        key={resets}
        name="menuItemId"
        value={item?.id}
        onChange={(event) => setChosen(event.target.value)}
      >
        {items.map((option, index) => (
          <option key={option.id} value={option.id}>
            {labels[index]}
          </option>
        ))}
      </Select>
    </Field>
  );
}
