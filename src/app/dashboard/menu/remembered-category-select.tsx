"use client";

import { useEffect, useRef } from "react";
import { inputClassName } from "../field";

/**
 * The category choice of an add form that clears itself after each save
 * (`resetOnSuccess`). A form's reset puts a select back on its first option, so
 * adding five dishes to Drinks meant choosing Drinks five times (#113). This
 * puts the choice back after the reset. Without JavaScript it's a plain select.
 */
export function RememberedCategorySelect({
  categories,
}: {
  categories: { id: string; name: string }[];
}) {
  const select = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    const form = select.current?.form;
    if (!form) return;
    // `reset` fires before the controls go back, so read the choice now and put it back after.
    const keep = () => {
      const chosen = select.current?.value;
      queueMicrotask(() => {
        if (select.current && chosen) select.current.value = chosen;
      });
    };
    form.addEventListener("reset", keep);
    return () => form.removeEventListener("reset", keep);
  }, []);

  return (
    <select ref={select} name="categoryId" className={inputClassName}>
      {categories.map((category) => (
        <option key={category.id} value={category.id}>
          {category.name}
        </option>
      ))}
    </select>
  );
}
