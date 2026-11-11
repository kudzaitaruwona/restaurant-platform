import Link from "next/link";
import type { InputHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

const chipBase =
  "inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-full border px-4 text-body font-medium whitespace-nowrap no-underline transition-colors duration-150 ease-out outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background [&_svg]:size-4 [&_svg]:shrink-0";

const chipTone = (selected: boolean) =>
  selected
    ? "border-transparent bg-brand text-brand-ink"
    : "border-line bg-surface text-ink hover:bg-surface-2";

/**
 * A pill (S-41) for filters and category links: a link with `href`, a plain
 * span otherwise. `selected` is the solid black (white in dark) state, and is
 * announced with aria-current on a link.
 */
export function Chip({
  href,
  selected = false,
  count,
  className,
  children,
}: {
  href?: string;
  selected?: boolean;
  /** A tabular number after the label, e.g. a column or filter count. */
  count?: number;
  className?: string;
  children: ReactNode;
}) {
  const classes = cn(chipBase, chipTone(selected), className);
  const content = (
    <>
      {children}
      {count !== undefined && <span className="tabular-nums opacity-75">{count}</span>}
    </>
  );
  return href !== undefined ? (
    <Link href={href} aria-current={selected ? "true" : undefined} className={classes}>
      {content}
    </Link>
  ) : (
    <span className={classes}>{content}</span>
  );
}

/**
 * A radio (or checkbox) drawn as a pill: party size, date, time, filters. It is
 * a real input, so it posts with its form and works without JavaScript. Chosen
 * is solid black (white in dark); disabled is a dashed outline. Server-friendly.
 */
export function ChoiceChip({
  type = "radio",
  className,
  children,
  ...input
}: {
  type?: "radio" | "checkbox";
  className?: string;
  children: ReactNode;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "className" | "children">) {
  return (
    <label className={cn("relative inline-flex", className)}>
      <input type={type} className="peer sr-only" {...input} />
      <span
        className={cn(
          chipBase,
          "w-full cursor-pointer border-line bg-surface text-ink hover:bg-surface-2",
          "peer-checked:border-transparent peer-checked:bg-brand peer-checked:text-brand-ink",
          "peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background",
          "peer-disabled:cursor-not-allowed peer-disabled:border-dashed peer-disabled:bg-transparent peer-disabled:text-ink-2",
        )}
      >
        {children}
      </span>
    </label>
  );
}
