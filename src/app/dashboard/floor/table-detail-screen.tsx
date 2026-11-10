import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { ActionForm } from "@/app/dashboard/action-form";
import { localTime } from "@/lib/booking-engine";
import { getTableDetail } from "@/lib/floor";
import { VOID_REASON_MAX } from "@/lib/kitchen-board";
import { getTenantContext } from "@/lib/tenant";
import { openFor } from "./floor-screen";

const statusWords = {
  placed: "Placed",
  cooking: "Cooking",
  done: "Done",
  delivered: "Delivered",
  voided: "Voided",
} as const;

/** Whether a line can still be voided: not delivered (it was eaten) or voided already. */
const voidable = (status: keyof typeof statusWords) => status !== "delivered" && status !== "voided";

/**
 * A void or reject behind a disclosure, with its required reason (#73). Plain
 * HTML until it posts, so it needs no script of its own.
 */
function ReasonForm({ action, label, submit }: { action: string; label: string; submit: string }) {
  return (
    <details className="text-sm">
      <summary className="cursor-pointer underline">{label}</summary>
      <ActionForm action={action} className="mt-2 flex flex-wrap items-center gap-2">
        <input
          name="reason"
          required
          maxLength={VOID_REASON_MAX}
          aria-label={`Reason to ${submit.toLowerCase()}`}
          placeholder="Reason"
          className="min-w-0 flex-1 rounded-md border px-2 py-1"
        />
        <button type="submit" className="rounded-md border border-destructive px-3 py-1 font-medium text-destructive">
          {submit}
        </button>
      </ActionForm>
    </details>
  );
}

/**
 * One table's open session (spec 06): every order and line with the customer's
 * name, the note and the status, Mark delivered on lines that are done, Void on
 * lines not yet delivered and Reject on orders with any (#73, S-36). A
 * table that isn't a live one of this restaurant is a 404. React escapes
 * everything a customer typed. `now` is for tests.
 */
export async function TableDetailScreen({ tableId, now }: { tableId: string; now?: Date }) {
  const tenant = await getTenantContext();
  // A malformed id is a 404, like an unknown one.
  const id = z.uuid().safeParse(tableId);
  if (!id.success) notFound();
  const detail = await getTableDetail(tenant, id.data);
  if (!detail) notFound();
  const { table, session, orders, timezone } = detail;
  const at = now ?? new Date();

  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">{table.label}</h1>
        <span className="flex gap-4">
          <Link className="underline" href={`/dashboard/floor/${table.id}`}>
            Refresh
          </Link>
          <Link className="underline" href="/dashboard/floor">
            Floor
          </Link>
        </span>
      </div>
      {!session ? (
        <p className="text-muted-foreground">No open session.</p>
      ) : (
        <>
          <p className="text-muted-foreground">
            Open since {localTime(session.openedAt, timezone)} ({openFor(session.openedAt, at)})
          </p>
          {session.waiterRequestedAt && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500 bg-amber-100 p-3 text-amber-950">
              <strong>Calling a waiter since {localTime(session.waiterRequestedAt, timezone)}</strong>
              <ActionForm action={`/api/floor/${table.id}/dismiss-waiter`}>
                <button type="submit" className="rounded-md border border-amber-950 px-3 py-1 font-medium">
                  Dismiss
                </button>
              </ActionForm>
            </div>
          )}
          {orders.length === 0 && <p className="text-muted-foreground">Nothing ordered yet.</p>}
          {orders.map((order) => (
            <section key={order.id} className="flex flex-col gap-2 rounded-md border p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="font-semibold">
                  {order.customerName}{" "}
                  <span className="text-sm font-normal text-muted-foreground">
                    at {localTime(order.placedAt, timezone)}
                  </span>
                </h2>
                {order.items.some((item) => voidable(item.status)) && (
                  <ReasonForm
                    action={`/api/orders/${order.id}/reject`}
                    label="Reject order…"
                    submit="Reject order"
                  />
                )}
              </div>
              <ul className="flex flex-col divide-y">
                {order.items.map((item) => (
                  <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span className="flex flex-col">
                      <span>
                        {item.quantity} × {item.name}
                      </span>
                      {item.note && <span className="text-sm text-muted-foreground">{item.note}</span>}
                    </span>
                    <span className="flex items-center gap-3">
                      <span className="text-sm font-medium">{statusWords[item.status]}</span>
                      {item.status === "done" && (
                        <ActionForm action={`/api/order-items/${item.id}/deliver`}>
                          <button type="submit" className="rounded-md border px-3 py-1 font-medium">
                            Mark delivered
                          </button>
                        </ActionForm>
                      )}
                      {voidable(item.status) && (
                        <ReasonForm
                          action={`/api/order-items/${item.id}/void`}
                          label="Void…"
                          submit="Void item"
                        />
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </>
  );
}
