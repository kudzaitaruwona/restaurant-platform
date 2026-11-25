import { z } from "zod";
import type { OutstandingItem } from "@/lib/closing";

/**
 * The parts the clear-table, force-close and reopen routes share (#74, #76): the session the
 * page showed, read from the form, and the answers they give.
 */
export const headers = { "cache-control": "no-store" };

/** The session id the table's detail put in the form, or null when it is missing or malformed. */
export function shownSessionFrom(form: FormData): string | null {
  const parsed = z.uuid().safeParse(form.get("session"));
  return parsed.success ? parsed.data : null;
}

/**
 * The outstanding items the table's detail listed, which a force-close voids
 * (#95): none when it listed none, or null when one is malformed.
 */
export function shownItemsFrom(form: FormData): string[] | null {
  const parsed = z.array(z.uuid()).safeParse(form.getAll("item"));
  return parsed.success ? parsed.data : null;
}

/**
 * `refresh` on a refusal has ActionForm reload the page, keeping the message up
 * (#95, #102): set wherever the answer is "what you're looking at is out of
 * date", so none of them asks the reader to reload.
 */
export const reloadToClose = () =>
  Response.json({ error: "That didn't say which session it was for. Check the table, then try again.", refresh: true }, { status: 400, headers });

export const sessionChanged = () =>
  Response.json(
    {
      error:
        "Nothing changed: the session this page showed had already closed, or a new party has sat down since.",
      refresh: true,
    },
    { status: 409, headers },
  );

const statusWords = { placed: "placed", cooking: "cooking", done: "done", delivered: "delivered", voided: "voided" };

const listed = (items: OutstandingItem[]) =>
  items.map((item) => ({
    id: item.id,
    summary: `${item.quantity} × ${item.name} for ${item.customerName}: ${statusWords[item.status]}`,
  }));

/**
 * Clear table refused: the items in the way, each as ActionForm lists it, and the
 * way out. Always a stale page: Clear is disabled while it shows any outstanding.
 */
export const blockedBy = (items: OutstandingItem[]) =>
  Response.json(
    {
      error:
        "This table has items that aren't delivered or voided yet. Deliver or void them, or force-close the table with a reason.",
      items: listed(items),
      refresh: true,
    },
    { status: 409, headers },
  );

/**
 * Force-close refused (#95): the items not yet delivered as they are now.
 * `refresh` has ActionForm reload the page, so its dialog lists them too.
 */
export const itemsChanged = (items: OutstandingItem[]) =>
  Response.json(
    {
      error:
        items.length > 0
          ? "The items not yet delivered have changed, so nothing was voided or closed. Check them, then force-close again:"
          : "The items have changed: every one is now delivered or voided, so nothing was voided or closed. You can clear the table.",
      items: listed(items),
      refresh: true,
    },
    { status: 409, headers },
  );

const reopenWords = {
  too_late:
    "It's more than 15 minutes since this session closed, so it can't be reopened. The next scan at the table starts a new session.",
  superseded: "A new party has opened this table since, so this session can't be reopened.",
  session_changed: "Nothing was reopened: this session has changed. It's open again already, or isn't this table's.",
};

/** A reopen Postgres or the page's precondition refused (#76): a 409 that says why. */
export const reopenRefused = (outcome: keyof typeof reopenWords) =>
  Response.json({ error: reopenWords[outcome], refresh: true }, { status: 409, headers });
