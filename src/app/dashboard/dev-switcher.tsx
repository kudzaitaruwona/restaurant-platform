import { FlaskConical } from "lucide-react";
import { devAuthBypassEnabled } from "@/lib/env";
import { devSwitcherIdentities } from "@/lib/tenant/dev-identities";

/**
 * Swaps between the seeded identities (S-25). Absent unless the bypass is on.
 * It takes sign-out's slot in the staff rail; the dashed outline keeps it
 * visibly not part of the product.
 */
export function DevSwitcher({ current }: { current?: string }) {
  if (!devAuthBypassEnabled()) return null;

  return (
    <details className="mx-2 mt-1 rounded-control border border-dashed border-line">
      <summary className="flex h-11 cursor-pointer list-none items-center gap-3.5 rounded-control px-[11px] text-caption text-ink-2 outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <FlaskConical aria-hidden className="size-5 shrink-0" strokeWidth={1.75} />
        <span className="rail-fade">Dev: act as</span>
      </summary>
      <form method="post" action="/api/dev/identity" className="grid gap-1 px-2 pb-2">
        {devSwitcherIdentities.map(({ key, label }) => (
          <button
            key={key}
            type="submit"
            name="identity"
            value={key}
            aria-current={key === current ? "true" : undefined}
            className="min-h-10 truncate rounded-control border border-line bg-surface px-3 text-left text-caption text-ink outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring aria-[current=true]:border-transparent aria-[current=true]:bg-brand-soft aria-[current=true]:font-semibold"
          >
            {label}
          </button>
        ))}
      </form>
    </details>
  );
}
