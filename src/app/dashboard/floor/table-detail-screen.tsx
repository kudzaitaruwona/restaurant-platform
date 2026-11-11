import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, MessageSquare, Undo2 } from "lucide-react";
import { z } from "zod";
import { ActionForm, type Confirmation } from "@/app/dashboard/action-form";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { StatusPill } from "@/components/ui/status-pill";
import { localTime } from "@/lib/booking-engine";
import { REOPEN_WINDOW_MINUTES } from "@/lib/closing";
import { getTableDetail } from "@/lib/floor";
import { VOID_REASON_MAX } from "@/lib/kitchen-board";
import { getTenantContext } from "@/lib/tenant";
import { cn } from "@/lib/utils";
import { RefreshAction, openFor } from "./floor-screen";
import { CallingBell, dismissButtonClassName } from "./waiter-call";

type LineStatus = "placed" | "cooking" | "done" | "delivered" | "voided";

/** How the last session closed, for the reopen offer (#76). */
const closedWords = {
  staff_clear: "cleared by staff",
  force_close: "force-closed",
  idle_expiry: "closed as idle",
  in_app_payment: "paid in the app",
  pos_payment: "paid at the till",
} as const;

/** Whether a line can still be voided: not delivered (it was eaten) or voided already. */
const voidable = (status: LineStatus) => status !== "delivered" && status !== "voided";

/**
 * The reason a void, reject or force-close asks for in its dialog (#73, #74,
 * S-41). The dialog checks it's there; the route has the final say.
 */
const reasonField = (hint: string): Confirmation["reason"] => ({
  label: "Reason",
  hint,
  required: true,
  maxLength: VOID_REASON_MAX,
});

/**
 * One table's open session (spec 06): every order and line with the customer's
 * name, the note and the status, Mark delivered on lines that are done, Void on
 * lines not yet delivered and Reject on orders with any (#73, S-36), and Clear
 * table and Force-close for the session (#74), pinned to the bottom. Void,
 * Reject and Force-close take their reason in a dialog (S-41). A free table
 * whose last session closed within the last 15 minutes offers Reopen (#76),
 * until when on the restaurant's clock; Postgres has the final say when it's
 * pressed. A table that isn't a live one of this restaurant is a 404. React
 * escapes everything a customer typed. `now` is for tests.
 */
export async function TableDetailScreen({ tableId, now }: { tableId: string; now?: Date }) {
  const tenant = await getTenantContext();
  // A malformed id is a 404, like an unknown one.
  const id = z.uuid().safeParse(tableId);
  if (!id.success) notFound();
  const detail = await getTableDetail(tenant, id.data);
  if (!detail) notFound();
  const { table, session, orders, timezone, reopenable } = detail;
  const at = now ?? new Date();
  const outstanding = orders.flatMap((order) => order.items.filter((item) => voidable(item.status)));

  return (
    <div className="flex flex-1 flex-col gap-5">
      <div>
        <Link
          href="/dashboard/floor"
          className="-mb-1 -ml-1.5 inline-flex min-h-12 items-center gap-1 pr-2 font-medium text-ink-2 no-underline hover:text-ink"
        >
          <ChevronLeft aria-hidden className="size-5" />
          Floor
        </Link>
        <PageHeader
          title={
            <>
              {table.label}
              <span className="ml-2 text-lead font-normal tracking-normal text-ink-2">Seats {table.capacity}</span>
            </>
          }
          subtitle={
            <span className="tabular-nums">
              {session
                ? `Open since ${localTime(session.openedAt, timezone)}, ${openFor(session.openedAt, at)}`
                : "Free. No open session."}
            </span>
          }
          actions={<RefreshAction href={`/dashboard/floor/${table.id}`} />}
        />
      </div>

      {!session ? (
        reopenable && (
          <Card as="section" className="flex flex-col gap-3 p-5">
            <h2 className="text-lead font-semibold">Last session</h2>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 tabular-nums">
              <dt className="text-ink-2">Closed</dt>
              <dd className="font-medium">
                {localTime(reopenable.closedAt, timezone)}, {closedWords[reopenable.closeReason ?? "staff_clear"]}
              </dd>
              <dt className="text-ink-2">Reopen until</dt>
              <dd className="font-medium">
                {localTime(new Date(reopenable.closedAt.getTime() + REOPEN_WINDOW_MINUTES * 60_000), timezone)}
              </dd>
            </dl>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-caption text-ink-2">Unless a new party sits down first.</p>
              <ActionForm action={`/api/floor/${table.id}/reopen`}>
                <input type="hidden" name="session" value={reopenable.id} />
                <Button type="submit" size="staff">
                  <Undo2 aria-hidden />
                  Reopen
                </Button>
              </ActionForm>
            </div>
          </Card>
        )
      ) : (
        <>
          {session.waiterRequestedAt && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-attention bg-attention-soft py-3 pr-3 pl-4 text-attention-ink">
              <strong className="flex items-center gap-2.5 text-lead font-semibold tabular-nums">
                <CallingBell />
                Calling a waiter since {localTime(session.waiterRequestedAt, timezone)}
              </strong>
              <ActionForm action={`/api/floor/${table.id}/dismiss-waiter`}>
                <button type="submit" className={dismissButtonClassName}>
                  Dismiss
                </button>
              </ActionForm>
            </div>
          )}
          {orders.length === 0 && <p className="text-ink-2">Nothing ordered yet.</p>}
          <div className="flex flex-col gap-3">
            {orders.map((order) => (
              <Card as="section" key={order.id}>
                <header className="flex min-h-16 items-center justify-between gap-3 border-b border-line py-2 pr-3 pl-4">
                  <h2 className="text-lead font-semibold">
                    {order.customerName}
                    <span className="ml-1.5 text-body font-normal text-ink-2 tabular-nums">
                      ordered {localTime(order.placedAt, timezone)}
                    </span>
                  </h2>
                  {order.items.some((item) => voidable(item.status)) && (
                    <ActionForm
                      action={`/api/orders/${order.id}/reject`}
                      confirmation={{
                        title: `Reject ${order.customerName}'s order?`,
                        description: "Every item not yet delivered is voided and comes off the kitchen board.",
                        confirmLabel: "Reject order",
                        reason: reasonField("Required. Recorded on each voided item."),
                      }}
                    >
                      <Button type="submit" variant="danger-ghost" size="compact">
                        Reject order
                      </Button>
                    </ActionForm>
                  )}
                </header>
                <ul className="divide-y divide-line">
                  {order.items.map((item) => {
                    const settled = !voidable(item.status);
                    return (
                      <li
                        key={item.id}
                        className="grid min-h-18 grid-cols-[32px_minmax(0,1fr)] items-center gap-x-3 gap-y-2 py-3 pr-3 pl-4 sm:grid-cols-[40px_minmax(0,1fr)_auto]"
                      >
                        <span
                          className={cn(
                            "text-lead text-ink-2 tabular-nums",
                            settled ? "font-normal" : "font-semibold",
                          )}
                        >
                          {item.quantity}x
                        </span>
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span
                            className={cn(
                              "text-lead",
                              settled ? "font-normal text-ink-2" : "font-medium",
                              item.status === "voided" && "line-through",
                            )}
                          >
                            {item.name}
                          </span>
                          {item.note && (
                            <span className="flex items-center gap-1.5 text-caption font-medium text-attention-ink">
                              <MessageSquare aria-hidden className="size-4 shrink-0" />
                              {item.note}
                            </span>
                          )}
                        </span>
                        <span className="col-start-2 flex flex-wrap items-center gap-2 sm:col-start-3 sm:justify-end">
                          <StatusPill status={item.status} className={cn(item.status === "delivered" && "px-1")} />
                          {item.status === "done" && (
                            <ActionForm action={`/api/order-items/${item.id}/deliver`}>
                              <Button type="submit" size="compact">
                                Mark delivered
                              </Button>
                            </ActionForm>
                          )}
                          {voidable(item.status) && (
                            <ActionForm
                              action={`/api/order-items/${item.id}/void`}
                              confirmation={{
                                title: `Void ${item.quantity}x ${item.name}?`,
                                description: `It comes off ${order.customerName}'s order and the kitchen board.`,
                                confirmLabel: "Void item",
                                reason: reasonField("Required. Recorded with the void."),
                              }}
                            >
                              <Button type="submit" variant="danger-ghost" size="compact">
                                Void
                              </Button>
                            </ActionForm>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            ))}
          </div>
          <div className="sticky bottom-0 z-10 -mx-4 mt-auto -mb-6 flex flex-wrap items-center justify-between gap-3 border-t border-line bg-surface px-4 py-3 shadow-[0_-6px_18px_rgb(var(--shadow)/0.06)] md:-mx-8 md:-mb-8 md:px-8">
            <p className="max-w-[34ch] text-caption text-ink-2">
              Clear table works once every item is delivered or voided.
            </p>
            <div className="flex flex-1 justify-end gap-2">
              <ActionForm
                action={`/api/floor/${table.id}/force-close`}
                confirmation={{
                  title: `Force-close ${table.label}?`,
                  description:
                    outstanding.length === 0 ? (
                      "Every item is delivered or voided. This closes the table."
                    ) : (
                      <>
                        <p>These items aren&apos;t delivered yet. Force-close voids them, then closes the table.</p>
                        <ul className="mt-3 divide-y divide-line rounded-control border border-line text-ink">
                          {outstanding.map((item) => (
                            <li key={item.id} className="flex justify-between gap-3 px-3 py-2.5">
                              <span>
                                {item.quantity}x {item.name}
                              </span>
                              <StatusPill status={item.status} />
                            </li>
                          ))}
                        </ul>
                      </>
                    ),
                  confirmLabel: outstanding.length === 0 ? "Close table" : `Void ${outstanding.length} and close`,
                  reason: reasonField("Required. Recorded on each voided item."),
                }}
              >
                <input type="hidden" name="session" value={session.id} />
                <Button type="submit" variant="danger-secondary" size="staff">
                  Force-close
                </Button>
              </ActionForm>
              <ActionForm action={`/api/floor/${table.id}/clear`}>
                <input type="hidden" name="session" value={session.id} />
                <Button type="submit" size="staff">
                  Clear table
                </Button>
              </ActionForm>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
