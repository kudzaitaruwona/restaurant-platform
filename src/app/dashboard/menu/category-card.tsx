import type { ReactNode } from "react";
import { cardClassName } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * One category of the menu editor (S-41): a card whose head holds the reorder
 * controls (owners), the name or its rename form, and the item count; the item
 * rows under it; and, for owners, the archive form in a quiet foot.
 * Server-friendly, so the sortable list and the staff list draw the same card.
 */
export function CategoryCard({
  controls,
  head,
  foot,
  dragging = false,
  children,
}: {
  controls?: ReactNode;
  head: ReactNode;
  foot?: ReactNode;
  dragging?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={cn(cardClassName, "overflow-hidden", dragging && "opacity-50")}>
      <div className="flex items-center gap-1 border-b border-line py-2 pr-3 pl-1.5 sm:pr-4">
        {controls}
        <div className={cn("min-w-0 flex-1", !controls && "pl-2.5")}>{head}</div>
      </div>
      {children}
      {foot && <div className="border-t border-line bg-surface-2/50 px-4 py-3">{foot}</div>}
    </section>
  );
}
