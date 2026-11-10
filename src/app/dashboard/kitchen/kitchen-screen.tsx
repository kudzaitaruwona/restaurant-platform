import Link from "next/link";
import { getPlacedItems } from "@/lib/kitchen";
import { getTenantContext } from "@/lib/tenant";

/**
 * The kitchen's list (spec 07, at /dashboard/kitchen per D-10), for anyone on
 * the team (S-26): every placed item with its table, quantity, name, note and
 * who ordered it. Plain server-rendered markup: React escapes what a customer
 * typed. No columns, actions or polling yet (#71).
 */
export async function KitchenScreen() {
  const tenant = await getTenantContext();
  const items = await getPlacedItems(tenant);

  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">Kitchen</h1>
        <Link className="underline" href="/dashboard">
          Dashboard
        </Link>
      </div>
      {items.length === 0 ? (
        <p className="text-muted-foreground">No orders waiting.</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {items.map((item) => (
            <li key={item.id} className="flex flex-col gap-1 p-4">
              <span className="text-2xl font-semibold">{item.table}</span>
              <span className="text-lg">
                {item.quantity} × {item.name}
              </span>
              {item.note && (
                <span className="rounded bg-amber-100 px-2 py-1 font-medium text-amber-950">
                  {item.note}
                </span>
              )}
              <span className="text-sm text-muted-foreground">For {item.customerName}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
