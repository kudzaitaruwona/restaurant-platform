"use client";

import { useState, type Ref } from "react";
import { cn } from "@/lib/utils";

const LENGTH = 6;

/** What was typed or pasted, as a code: digits only, at most six. */
export function codeFrom(raw: string) {
  return raw.replace(/\D/g, "").slice(0, LENGTH);
}

/** True when this change finishes the code (not when it was already full). */
export function completes(next: string, previous: string) {
  return next.length === LENGTH && next !== previous;
}

/**
 * The 6-digit code, drawn as six boxes over ONE real input. One input keeps
 * the platform's own behaviour: the SMS/email code suggestion
 * (autocomplete="one-time-code"), paste of the whole code, backspace, and
 * screen readers reading it as one field. Anything that isn't a digit is
 * dropped (so a pasted "123 456" works), and the sixth digit hands over to
 * `onComplete`, so nobody has to find the button.
 */
export function CodeInput({
  value,
  onChange,
  onComplete,
  invalid,
  disabled,
  ref,
  id,
}: {
  value: string;
  onChange: (code: string) => void;
  onComplete: (code: string) => void;
  invalid?: boolean;
  disabled?: boolean;
  ref?: Ref<HTMLInputElement>;
  id?: string;
}) {
  const [focused, setFocused] = useState(false);
  const active = Math.min(value.length, LENGTH - 1);

  return (
    <div className="relative">
      <div aria-hidden className="grid grid-cols-6 gap-2">
        {Array.from({ length: LENGTH }, (_, index) => (
          <span
            key={index}
            className={cn(
              "grid h-14 place-items-center rounded-control border bg-surface text-title font-semibold tabular-nums text-ink transition-[border-color,box-shadow] duration-150 ease-out",
              invalid ? "border-danger" : "border-line",
              focused && index === active && !invalid && "border-ring ring-2 ring-ring/30",
              disabled && "opacity-60",
            )}
          >
            {value[index] ?? ""}
            {focused && index === value.length && (
              <span className="h-6 w-px animate-pulse bg-ink motion-reduce:animate-none" />
            )}
          </span>
        ))}
      </div>
      <input
        ref={ref}
        id={id}
        value={value}
        onChange={(event) => {
          const code = codeFrom(event.target.value);
          onChange(code);
          if (completes(code, value)) onComplete(code);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        // No maxLength: the browser would cut a pasted "123 456" to "123 45"
        // before codeFrom could drop the space. codeFrom caps it at 6 digits.
        required
        autoFocus
        // Read-only rather than disabled while checking, so focus stays put.
        readOnly={disabled}
        aria-busy={disabled || undefined}
        onSelect={(event) => {
          // The boxes show the caret at the end; keep the real one there too.
          const input = event.currentTarget;
          const end = input.value.length;
          if (input.selectionStart !== end) input.setSelectionRange(end, end);
        }}
        aria-invalid={invalid || undefined}
        // Invisible but real: it takes the taps, the typing and the paste.
        className="absolute inset-0 h-full w-full cursor-text bg-transparent text-control text-transparent caret-transparent outline-none selection:bg-transparent"
      />
    </div>
  );
}
