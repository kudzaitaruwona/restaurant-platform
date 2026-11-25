export type Refusal = {
  message: string;
  bookings: { id: string; summary: string; href?: string }[];
  /** A 409 that asks first: nothing was saved (lib/confirmation.ts). */
  warnings: string[];
  /** What the page shows is out of date (#95): reload it, keeping the refusal up. */
  refresh: boolean;
};

/**
 * A page of ActionForms shows one refusal at a time: when any form on the page
 * is sent, the others clear theirs, so two refused actions never stack.
 */
type Listener = (sender: symbol) => void;
const listeners = new Set<Listener>();

/** Tells every other form on the page that this one is being sent. */
export function announceSend(sender: symbol) {
  for (const listener of [...listeners]) listener(sender);
}

/** Calls `clear` whenever a different form is sent; returns the unsubscribe. */
export function clearOnOtherSend(self: symbol, clear: () => void) {
  const listener: Listener = (sender) => {
    if (sender !== self) clear();
  };
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/**
 * A page's own refusal (#102), which outlives the form that met it: a stale page
 * reloads, and the form may be gone from it. Cleared when any form is sent, and
 * when the page is hidden, so it is never there on coming back.
 */
export function pageRefusal() {
  let current: Refusal | undefined;
  let changed: (() => void) | undefined;
  const set = (next: Refusal | undefined) => {
    if (!changed) return; // hidden, or gone
    current = next;
    changed();
  };
  return {
    get: () => current,
    show: (refusal: Refusal) => set(refusal),
    subscribe(listener: () => void) {
      changed = listener;
      const off = clearOnOtherSend(Symbol("page"), () => set(undefined));
      return () => {
        off();
        changed = undefined;
        current = undefined;
      };
    },
  };
}

/** Whether a refusal shows on the page or in its form: a stale one may lose the form. */
export const refusalPlace = (refusal: Refusal, { page, onPage }: { page: boolean; onPage: boolean }) =>
  page && (onPage || refusal.refresh) ? "page" : "form";
