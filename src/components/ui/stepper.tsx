"use client";

import { Minus, Plus } from "lucide-react";
import { type InputHTMLAttributes, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * The value one step up or down from `current`, kept inside [min, max]. An
 * empty or unreadable value starts from `min` (or 0).
 */
export function stepValue(
  current: string,
  direction: 1 | -1,
  { min, max, step = 1 }: { min?: number; max?: number; step?: number },
): string {
  const parsed = Number.parseFloat(current);
  const base = Number.isFinite(parsed) ? parsed : (min ?? 0);
  let next = Number.isFinite(parsed) ? base + direction * step : base;
  if (min !== undefined) next = Math.max(min, next);
  if (max !== undefined) next = Math.min(max, next);
  return String(next);
}

const toNumber = (value: InputHTMLAttributes<HTMLInputElement>["min"]) =>
  value === undefined || value === "" ? undefined : Number(value);

/**
 * A number input between 48px minus and plus buttons (S-41). The input is a
 * real `<input type="number">` that posts with its form and works without
 * JavaScript; the buttons are an enhancement. Label it with `aria-labelledby`
 * or an id and a <label htmlFor>.
 */
export function Stepper({
  className,
  decreaseLabel = "One fewer",
  increaseLabel = "One more",
  min,
  max,
  step,
  ...input
}: {
  className?: string;
  decreaseLabel?: string;
  increaseLabel?: string;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "className">) {
  const ref = useRef<HTMLInputElement>(null);

  function nudge(direction: 1 | -1) {
    const field = ref.current;
    if (!field || field.disabled) return;
    field.value = stepValue(field.value, direction, {
      min: toNumber(min),
      max: toNumber(max),
      step: toNumber(step),
    });
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  }

  const button =
    "grid size-12 shrink-0 place-items-center rounded-control text-ink outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 [&_svg]:size-5";

  return (
    <span
      className={cn(
        "inline-flex h-12 items-center rounded-control border border-line bg-surface",
        className,
      )}
    >
      <button type="button" aria-label={decreaseLabel} className={button} onClick={() => nudge(-1)} disabled={input.disabled}>
        <Minus aria-hidden />
      </button>
      <input
        ref={ref}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={step}
        className="h-full w-12 min-w-0 appearance-none border-0 bg-transparent text-center text-lead font-semibold tabular-nums text-ink outline-none [-moz-appearance:textfield] focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        {...input}
      />
      <button type="button" aria-label={increaseLabel} className={button} onClick={() => nudge(1)} disabled={input.disabled}>
        <Plus aria-hidden />
      </button>
    </span>
  );
}
