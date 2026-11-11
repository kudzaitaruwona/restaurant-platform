import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const tones = {
  /** Outlined, for a plain fact: "Bundle", "Starts later". */
  neutral: "border border-line bg-transparent text-ink",
  /** Filled grey, for something switched off: "Sold out", "Turned off". */
  muted: "bg-surface-2 text-ink-2",
  /** Green, for a positive live state: "On now". */
  positive: "bg-accent-soft text-accent",
} as const;

/**
 * A small pill for the menu editor's own states (sold out, bundle, a special's
 * state), drawn like StatusPill (S-41): 13px semibold, fully rounded, a word
 * and usually an icon. StatusPill has no menu states, so this lives here until
 * it is promoted. Server-friendly.
 */
export function Pill({
  tone = "neutral",
  icon,
  className,
  children,
}: {
  tone?: keyof typeof tones;
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2.5 text-caption font-semibold whitespace-nowrap [&_svg]:size-3.5 [&_svg]:shrink-0",
        tones[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}
