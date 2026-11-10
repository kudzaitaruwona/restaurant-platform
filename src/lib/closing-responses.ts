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

export const reloadToClose = () =>
  Response.json({ error: "Reload the table and try again." }, { status: 400, headers });

export const sessionChanged = () =>
  Response.json(
    {
      error:
        "This table's session has changed since the page loaded: it has closed, or a new party has sat down. Reload the table.",
    },
    { status: 409, headers },
  );

const statusWords = { placed: "placed", cooking: "cooking", done: "done", delivered: "delivered", voided: "voided" };

/** Clear table refused: the items in the way, each as ActionForm lists it, and the way out. */
export const blockedBy = (items: OutstandingItem[]) =>
  Response.json(
    {
      error:
        "This table has items that aren't delivered or voided yet. Deliver or void them, or force-close the table with a reason.",
      items: items.map((item) => ({
        id: item.id,
        summary: `${item.quantity} × ${item.name} for ${item.customerName}: ${statusWords[item.status]}`,
      })),
    },
    { status: 409, headers },
  );

const reopenWords = {
  too_late:
    "It's more than 15 minutes since this session closed, so it can't be reopened. The next scan at the table starts a new session.",
  superseded: "A new party has opened this table since, so this session can't be reopened. Reload the table.",
  session_changed: "This session has changed since the page loaded: it's open again, or isn't this table's. Reload the table.",
};

/** A reopen Postgres or the page's precondition refused (#76): a 409 that says why. */
export const reopenRefused = (outcome: keyof typeof reopenWords) =>
  Response.json({ error: reopenWords[outcome] }, { status: 409, headers });
