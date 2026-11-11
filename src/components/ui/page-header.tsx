import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The top of a staff page (S-41): a 24px semibold title, an optional quiet
 * subtitle, and the page's actions on the right (the primary one last). On a
 * phone the actions wrap under the title. Server-friendly.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn("flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-3", className)}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-heading font-semibold tracking-[-0.01em] text-ink">{title}</h1>
        {subtitle && <p className="text-body text-ink-2">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
