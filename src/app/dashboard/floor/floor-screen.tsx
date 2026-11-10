import Link from "next/link";
import { ActionForm } from "@/app/dashboard/action-form";
import { localTime } from "@/lib/booking-engine";
import { type ItemCounts, getFloor } from "@/lib/floor";
import { getTenantContext } from "@/lib/tenant";

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

/**
 * The floor (spec 06, at /dashboard/floor per D-10), for anyone on the team
 * (S-26): every live table, free or open, how long it has been open and its
 * item counts, and a call to a waiter (proposed) with its dismiss. Server-rendered, so React escapes every label. It stays current
 * by reloading: no polling yet. `now` is for tests.
 */
export async function FloorScreen({ now }: { now?: Date } = {}) {
  const tenant = await getTenantContext();
  const { tables, timezone } = await getFloor(tenant);
  const at = now ?? new Date();

  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">Floor</h1>
        <span className="flex gap-4">
          <Link className="underline" href="/dashboard/floor">
            Refresh
          </Link>
          <Link className="underline" href="/dashboard">
            Dashboard
          </Link>
        </span>
      </div>
      {tables.length === 0 ? (
        <p className="text-muted-foreground">No tables yet.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {tables.map((table) => (
            <li key={table.id}>
              <Link
                href={`/dashboard/floor/${table.id}`}
                className="flex flex-col gap-2 rounded-md border p-4 hover:bg-muted"
              >
                <span className="text-2xl font-semibold">{table.label}</span>
                {table.openedAt ? (
                  <span>
                    <strong>Open</strong> since {localTime(table.openedAt, timezone)} (
                    {openFor(table.openedAt, at)})
                  </span>
                ) : (
                  <span className="text-muted-foreground">Free</span>
                )}
                {table.openedAt && (
                  <span className="flex flex-wrap gap-x-4 text-sm">
                    {countLabels.map(([status, label]) => (
                      <span key={status}>
                        {label}: {table.counts[status]}
                      </span>
                    ))}
                  </span>
                )}
              </Link>
              {table.waiterRequestedAt && (
                <div className="mt-1 flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500 bg-amber-100 p-2 text-amber-950">
                  <strong>Calling a waiter since {localTime(table.waiterRequestedAt, timezone)}</strong>
                  <ActionForm action={`/api/floor/${table.id}/dismiss-waiter`}>
                    <button type="submit" className="rounded-md border border-amber-950 px-3 py-1 font-medium">
                      Dismiss
                    </button>
                  </ActionForm>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
