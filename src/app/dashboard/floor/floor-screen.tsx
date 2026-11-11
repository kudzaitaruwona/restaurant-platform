import Link from "next/link";
import { LayoutGrid, RefreshCw, TriangleAlert } from "lucide-react";
import { ActionForm } from "@/app/dashboard/action-form";
import { StaffTopBarAction } from "@/app/dashboard/shell/top-bar-action";
import { buttonVariants } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { PageHeader } from "@/components/ui/page-header";
import { localTime } from "@/lib/booking-engine";
import { type ItemCounts, getFloor } from "@/lib/floor";
import { IDLE_EXPIRY_MINUTES } from "@/lib/session-idle";
import { getTenantContext } from "@/lib/tenant";
import { cn } from "@/lib/utils";
import { CallingBell, dismissButtonClassName } from "./waiter-call";

const countLabels: [keyof ItemCounts, string][] = [
  ["placed", "Placed"],
  ["cooking", "Cooking"],
  ["done", "Done"],
  ["delivered", "Delivered"],
];

/** "35 min", "1 h 5 min": how long a session has been open. */
export const openFor = (opened: Date, now: Date) => {
  const minutes = Math.max(0, Math.floor((now.getTime() - opened.getTime()) / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
};

/** Refresh, in the page header from a tablet up and in the phone's top bar below. */
export function RefreshAction({ href }: { href: string }) {
  return (
    <>
      <Link
        href={href}
        className={cn(buttonVariants({ variant: "secondary", size: "staff" }), "hidden md:inline-flex")}
      >
        <RefreshCw aria-hidden />
        Refresh
      </Link>
      <StaffTopBarAction>
        <IconButton href={href} label="Refresh" icon={<RefreshCw />} variant="ghost" />
      </StaffTopBarAction>
    </>
  );
}

/**
 * The floor (spec 06, at /dashboard/floor per D-10), for anyone on the team
 * (S-26): every live table, free or open, how long it has been open and its
 * item counts, a flag on one idle expiry can't close (spec 06), and a call to a
 * waiter (proposed) with its dismiss. Open tables are solid cards led by how
 * long they've been open; free ones are dashed outlines, so the busy tables
 * stand out without colour. Amber means someone should go to the table (S-41).
 * Server-rendered, so React escapes every label. It stays current by
 * reloading: no polling yet. `now` is for tests.
 */
export async function FloorScreen({ now }: { now?: Date } = {}) {
  const tenant = await getTenantContext();
  const { tables, timezone } = await getFloor(tenant);
  const at = now ?? new Date();

  return (
    <>
      <PageHeader title="Floor" actions={<RefreshAction href="/dashboard/floor" />} />
      {tables.length === 0 ? (
        <div className="flex flex-col items-center gap-3 px-6 py-18 text-center">
          <span className="grid size-14 place-items-center rounded-card bg-surface-2 text-ink-2">
            <LayoutGrid aria-hidden className="size-6" />
          </span>
          <h2 className="text-title font-semibold">No tables yet</h2>
          <p className="max-w-[36ch] text-ink-2">
            Once the owner adds tables under Tables, each one shows here, free or open.
          </p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {tables.map((table) => {
            const open = table.openedAt !== null;
            return (
              <li key={table.id}>
                <article
                  className={cn(
                    "flex h-full flex-col overflow-hidden rounded-card border",
                    open
                      ? "border-line bg-surface"
                      : "border-dashed border-[color-mix(in_srgb,var(--ink-2)_35%,var(--line))] bg-transparent",
                    table.waiterRequestedAt && "border-attention shadow-[inset_0_0_0_1px_var(--attention)]",
                  )}
                >
                  {table.waiterRequestedAt && (
                    <div className="flex items-center justify-between gap-3 bg-attention-soft py-2 pr-2 pl-4 text-attention-ink">
                      <strong className="flex items-center gap-2 font-semibold tabular-nums">
                        <CallingBell />
                        Calling since {localTime(table.waiterRequestedAt, timezone)}
                      </strong>
                      <ActionForm action={`/api/floor/${table.id}/dismiss-waiter`}>
                        <button type="submit" className={dismissButtonClassName}>
                          Dismiss
                        </button>
                      </ActionForm>
                    </div>
                  )}
                  <Link
                    href={`/dashboard/floor/${table.id}`}
                    className={cn(
                      "flex flex-1 flex-col gap-3 p-4 text-ink no-underline outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                      open
                        ? "hover:bg-[color-mix(in_srgb,var(--surface-2)_50%,var(--surface))]"
                        : "py-3 hover:bg-surface sm:py-4",
                    )}
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="text-heading leading-none font-semibold tracking-[-0.01em]">
                        {table.label}
                        <span className="ml-2 text-caption font-normal tracking-normal text-ink-2">
                          Seats {table.capacity}
                        </span>
                      </span>
                      <span
                        className={cn(
                          "rounded-full px-2.5 py-0.5 text-caption font-semibold",
                          open ? "bg-brand-soft text-ink" : "bg-surface-2 text-ink-2",
                        )}
                      >
                        {open ? "Open" : "Free"}
                      </span>
                    </span>
                    {table.openedAt && (
                      <span className="flex items-baseline gap-2 tabular-nums">
                        <span className="text-title font-semibold">{openFor(table.openedAt, at)}</span>
                        <span className="text-ink-2">since {localTime(table.openedAt, timezone)}</span>
                      </span>
                    )}
                    {table.status === "flagged" && (
                      <span className="flex items-start gap-2 rounded-control bg-attention-soft px-3 py-2.5 text-caption text-attention-ink">
                        <TriangleAlert aria-hidden className="mt-px size-4 shrink-0" />
                        <span>
                          <strong className="font-semibold">Flagged.</strong> No activity for {IDLE_EXPIRY_MINUTES}{" "}
                          minutes, and items not delivered, so it can&apos;t close on its own.
                        </span>
                      </span>
                    )}
                    {table.openedAt && (
                      <dl className="mt-auto grid grid-cols-4 border-t border-line pt-3 tabular-nums">
                        {countLabels.map(([status, label]) => {
                          const count = table.counts[status];
                          return (
                            <div
                              key={status}
                              className={cn(
                                "flex flex-col gap-0.5",
                                count === 0
                                  ? "[&>dd]:font-normal [&>dd]:text-ink-2"
                                  : status === "done" && "[&>dd]:text-accent",
                              )}
                            >
                              <dt className="text-caption text-ink-2">{label}</dt>
                              <dd className="text-title leading-tight font-semibold">{count}</dd>
                            </div>
                          );
                        })}
                      </dl>
                    )}
                  </Link>
                </article>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
