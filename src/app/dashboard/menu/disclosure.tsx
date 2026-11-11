import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

/**
 * A form used now and then (a bundle, a special), folded under a 48px heading
 * row with a chevron. A <details>, so it opens without JavaScript.
 * Server-friendly.
 */
export function Disclosure({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="group">
      <summary className="-mx-2 flex min-h-12 cursor-pointer list-none items-center justify-between gap-2 rounded-control px-2 text-lead font-semibold outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        {title}
        <ChevronDown
          aria-hidden
          className="size-5 text-ink-2 transition-transform duration-150 group-open:rotate-180 motion-reduce:transition-none"
        />
      </summary>
      <div className="pt-3 pb-4">{children}</div>
    </details>
  );
}
