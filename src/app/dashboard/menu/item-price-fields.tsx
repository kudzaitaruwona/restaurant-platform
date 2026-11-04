"use client";

import { useEffect, useRef, useState } from "react";
import { calculatedZigNote, type Pricing } from "@/lib/pricing";
import { Field, inputClassName } from "../field";

/**
 * The USD and ZiG price fields of the item form, with the value a blank ZiG
 * field would get (spec 02 › Items). Calculated in the browser with the same
 * module the public page uses, so the two can't disagree.
 */
export function ItemPriceFields({ pricing }: { pricing: Pricing }) {
  const [usd, setUsd] = useState("");
  const anchor = useRef<HTMLDivElement>(null);

  // ActionForm resets the form after a save, which React doesn't see.
  useEffect(() => {
    const form = anchor.current?.closest("form");
    const clear = () => setUsd("");
    form?.addEventListener("reset", clear);
    return () => form?.removeEventListener("reset", clear);
  }, []);

  const note = calculatedZigNote(usd, pricing);

  return (
    <div ref={anchor} className="flex flex-col gap-4">
      <Field label="Price (USD)">
        <input
          name="priceUsd"
          inputMode="decimal"
          value={usd}
          onChange={(event) => setUsd(event.target.value)}
          className={inputClassName}
        />
      </Field>
      <Field
        label="Price (ZiG), leave blank to calculate it"
        hint={note && <span role="status">{note}</span>}
      >
        <input name="priceZig" inputMode="decimal" className={inputClassName} />
      </Field>
    </div>
  );
}
