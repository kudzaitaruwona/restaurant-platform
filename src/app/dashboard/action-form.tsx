"use client";

import {
  type FormEvent,
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { flushSync } from "react-dom";
import { ConfirmDialog, type ConfirmReason } from "@/components/ui/confirm-dialog";
import { CONFIRMED_FIELD } from "@/lib/confirmation";
import { postForm } from "@/lib/form-response";
import { type Place, focusLost, giveFocusBack, placeOf } from "@/lib/held-focus";
import { type Saved, settleSave, withinRefreshLimit } from "@/lib/save-refresh";
import { SavedMessage, currentPage, useRefresh, useSaySaved } from "../page-refresh";
import { type Refusal, announceSend, clearOnOtherSend, pageRefusal, refusalPlace } from "./refusals";

/** What the in-page confirmation says (S-41). */
export type Confirmation = {
  /** A question: "Cancel this booking?" */
  title: string;
  description?: ReactNode;
  /** Says what it does: "Cancel booking". */
  confirmLabel: string;
  /** Default "Cancel". */
  cancelLabel?: string;
  /** Default "danger" (solid red); "primary" is solid black. */
  tone?: "danger" | "primary";
  /** Asks for a reason, posted with the form as `reason.name` (default "reason"). */
  reason?: ConfirmReason;
};

/** A plain-text confirmation, as screens wrote them before S-41, becomes a dialog with that question. */
export const confirmationOf = (confirmation: string | Confirmation): Confirmation =>
  typeof confirmation === "string"
    ? { title: confirmation, confirmLabel: "Confirm", cancelLabel: "Go back" }
    : confirmation;

/**
 * A form that posts to a route handler and shows the refusal in place, keeping
 * what was typed. Without JavaScript it's still a plain post. With a
 * `confirmation`, it asks first in an in-page dialog (S-41), not the browser's
 * confirm(); a reason typed there posts with the form.
 *
 * After a save it stays pending until the refreshed page has rendered, then says
 * what it saved, or leaves that to the page if it is gone by then (#111). Focus
 * goes back to the control that was used, or close by.
 */
export function ActionForm({
  action,
  id,
  className,
  confirmation,
  resetOnSuccess = false,
  keepOnReset = [],
  savedMessage,
  refusalOnPage = false,
  refreshOnRefusal = false,
  children,
}: {
  action: string;
  /** Lets a button elsewhere submit it with `form={id}`, e.g. a RowMenuItem. */
  id?: string;
  className?: string;
  confirmation?: string | Confirmation;
  resetOnSuccess?: boolean;
  /** Fields (by name) that keep their value through the reset, e.g. the time chosen for the next booking. */
  keepOnReset?: string[];
  savedMessage?: string;
  /** Shows its refusals on the page (PageRefusalAlert), for a form whose surroundings can't grow (#102). */
  refusalOnPage?: boolean;
  /** Reloads the page's data after a refusal too, for a form whose page shows what the refusal found out (a stale list). */
  refreshOnRefusal?: boolean;
  children: ReactNode;
}) {
  const refresh = useRefresh();
  const saySaved = useSaySaved();
  const formRef = useRef<HTMLFormElement>(null);
  const fieldsRef = useRef<HTMLFieldSetElement>(null);
  const [error, setError] = useState<Refusal>();
  const [saved, setSaved] = useState<Saved>();
  const page = useContext(PageRefusalContext);
  const [pending, setPending] = useState(false);
  // `pending` as events see it, before it has rendered: a second tap posts nothing.
  const sending = useRef(false);
  const sends = useRef(0);
  const [asking, setAsking] = useState(false);
  const [self] = useState(() => Symbol("action-form"));
  // One refusal on the page at a time: sending another form clears this one's. A
  // warning isn't a refusal: its dialog is modal, and answering it sends again.
  useEffect(() => clearOnOtherSend(self, () => setError(undefined)), [self]);
  // What the server wants the person to see before it saves (lib/confirmation.ts).
  // Kept after it closes, so the dialog stays mounted and closes itself.
  const [warnings, setWarnings] = useState<string[]>([]);
  const [warned, setWarned] = useState(false);
  // The control it was sent with, and its place on the page while pending.
  const opener = useRef<Element | null>(null);
  const place = useRef<Place | undefined>(undefined);
  const holder = useRef<HTMLSpanElement>(null);
  const ask = confirmation === undefined ? undefined : confirmationOf(confirmation);

  // After the dialogs' own effects, so a dialog has closed and returned focus.
  useEffect(() => {
    const form = formRef.current;
    const fields = fieldsRef.current;
    if (!pending || !form || !fields) return;
    const active = document.activeElement;
    // The disabled fieldset drops focus, so it waits in the form, on "Saving".
    const lost = focusLost(active, document.body);
    const used = lost ? opener.current : active;
    place.current = used ? placeOf(used) : undefined;
    if (lost) holder.current?.focus({ preventScroll: true });
    // The buttons outside it that send it, and the menu it was sent from: not
    // disabled, so that they keep focus.
    const outside = [...form.elements, used].filter(
      (el): el is HTMLButtonElement =>
        el instanceof HTMLButtonElement &&
        !fields.contains(el) &&
        !el.hasAttribute("aria-disabled") &&
        el.getAttribute("role") !== "menuitem",
    );
    for (const button of outside) button.setAttribute("aria-disabled", "true");
    return () => {
      for (const button of outside) button.removeAttribute("aria-disabled");
    };
  }, [pending]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current) return;
    // Enter in a field submits too. Safari doesn't focus a clicked button.
    const focused = document.activeElement;
    opener.current =
      focused && event.currentTarget.contains(focused)
        ? focused
        : (event.nativeEvent as SubmitEvent).submitter;
    if (ask) setAsking(true);
    else void send(event.currentTarget);
  }

  async function refuse(refusal: Refusal) {
    if (page && refusalPlace(refusal, { page: true, onPage: refusalOnPage }) === "page") await page.show(refusal);
    else {
      setError(refusal);
      if (refusal.refresh) await withinRefreshLimit(refresh());
    }
    if (refreshOnRefusal && !refusal.refresh) await withinRefreshLimit(refresh());
  }

  async function post(form: HTMLFormElement, body: FormData) {
    const response = await postForm(action, body).catch(() => undefined);
    if (!response) {
      await refuse({ message: "That didn't reach the server. Try again.", bookings: [], warnings: [], refresh: false });
      return;
    }
    if (!response.ok) {
      const refusal = await refusalFrom(response);
      if (refusal.warnings.length === 0) await refuse(refusal);
      return refusal.warnings;
    }
    if (resetOnSuccess) {
      const kept = keepOnReset.flatMap((name) => {
        const field = form.elements.namedItem(name);
        return field instanceof HTMLSelectElement || field instanceof HTMLInputElement
          ? [[field, field.value] as const]
          : [];
      });
      form.reset();
      for (const [field, value] of kept) field.value = value;
    }
    const sent = sends.current;
    await settleSave({
      form,
      saved: (await savedFrom(response)) ?? (savedMessage === undefined ? undefined : { message: savedMessage, plain: true }),
      refresh,
      page: currentPage,
      inForm: setSaved,
      onPage: saySaved,
      isLatest: () => sends.current === sent,
    });
  }

  async function send(form: HTMLFormElement, confirmed = false) {
    const body = new FormData(form); // before the fieldset disables its controls
    const sentFrom = currentPage();
    sending.current = true;
    sends.current++;
    place.current = undefined;
    announceSend(self);
    if (confirmed) body.set(CONFIRMED_FIELD, "1");
    setPending(true);
    setError(undefined);
    setSaved(undefined);
    let asks: string[] | undefined;
    try {
      asks = await post(form, body);
    } finally {
      sending.current = false;
      // Enabled at once, so the control can take focus back, before any dialog opens.
      flushSync(() => setPending(false));
      if (place.current && currentPage() === sentFrom) giveFocusBack(place.current);
    }
    if (asks?.length) {
      setWarnings(asks);
      setWarned(true);
    }
  }

  return (
    <form ref={formRef} id={id} method="post" action={action} onSubmit={submit}>
      <fieldset ref={fieldsRef} disabled={pending} className={className}>
        {children}
        {saved && (
          <div role="status">
            <SavedMessage saved={saved} />
          </div>
        )}
        {error && <RefusalAlert refusal={error} />}
      </fieldset>
      {pending && (
        <span ref={holder} tabIndex={-1} className="sr-only">
          Saving
        </span>
      )}
      {warnings.length > 0 && (
        <ConfirmDialog
          open={warned}
          title="Save anyway?"
          description={
            <ul className="list-disc space-y-1 pl-5">
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          }
          confirmLabel="Save anyway"
          cancelLabel="Go back"
          tone="primary"
          pending={pending}
          onCancel={() => setWarned(false)}
          onConfirm={() => {
            setWarned(false);
            if (formRef.current) void send(formRef.current, true);
          }}
        />
      )}
      {ask && (
        <ConfirmDialog
          {...ask}
          open={asking}
          pending={pending}
          onCancel={() => setAsking(false)}
          onConfirm={() => {
            setAsking(false);
            if (formRef.current) void send(formRef.current);
          }}
        />
      )}
    </form>
  );
}

const PageRefusalContext = createContext<
  | { refusal: Refusal | undefined; refreshing: boolean; show: (refusal: Refusal) => Promise<void> }
  | undefined
>(undefined);

/**
 * Gives a page a place of its own for refusals (#102): a stale form's, which
 * reloads the page and may take the form with it, and those of forms with
 * `refusalOnPage`. They show where PageRefusalAlert is.
 */
export function PageRefusals({ className, children }: { className?: string; children: ReactNode }) {
  const refresh = useRefresh();
  const [store] = useState(pageRefusal);
  const refusal = useSyncExternalStore(store.subscribe, store.get, () => undefined);
  const [refreshing, setRefreshing] = useState(false);
  /** Settles once the page that a stale refusal reloads has rendered. */
  async function show(next: Refusal) {
    store.show(next);
    if (!next.refresh) return;
    setRefreshing(true);
    await withinRefreshLimit(refresh());
    setRefreshing(false);
  }
  return (
    <PageRefusalContext value={{ refusal, refreshing, show }}>
      <div className={className}>{children}</div>
    </PageRefusalContext>
  );
}

/**
 * The page's refusal, in the page's flow so that it covers nothing, and scrolled
 * into view: when it appears, and once the refreshed page has settled.
 */
export function PageRefusalAlert({ className }: { className?: string }) {
  const { refusal, refreshing } = useContext(PageRefusalContext) ?? {};
  const place = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (refusal) place.current?.scrollIntoView({ block: "nearest" });
  }, [refusal, refreshing]);
  return (
    refusal && (
      <div ref={place} className={className}>
        <RefusalAlert refusal={refusal} />
      </div>
    )
  );
}

/** A refusal in place: its message, and the items or bookings in the way. */
export function RefusalAlert({ refusal }: { refusal: Refusal }) {
  return (
    <div role="alert" className="text-caption text-danger">
      <p>{refusal.message}</p>
      {refusal.bookings.length > 0 && (
        <ul className="list-disc pl-5">
          {refusal.bookings.map((booking) => (
            <li key={booking.id}>
              {booking.href ? (
                // A full load, so the day's row is the page's :target.
                <a href={booking.href} className="underline underline-offset-2">
                  {booking.summary}
                </a>
              ) : (
                booking.summary
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * A save that answers 200 with `{ saved: { message, href?, linkLabel?, warning? } }`
 * shows that instead of the form's fixed message. The link goes only to the
 * dashboard's own pages, whatever the body says.
 */
export async function savedFrom(response: Response): Promise<Saved | undefined> {
  if (response.status === 204) return undefined;
  const saved = (await response.json().catch(() => undefined))?.saved;
  if (typeof saved?.message !== "string") return undefined;
  return {
    message: saved.message,
    ...(typeof saved.href === "string" && /^\/dashboard\//.test(saved.href) ? { href: saved.href } : {}),
    ...(typeof saved.linkLabel === "string" ? { linkLabel: saved.linkLabel } : {}),
    ...(typeof saved.warning === "string" ? { warning: saved.warning } : {}),
  };
}

/**
 * A refusal says why, and may list what is in the way: the bookings on a table
 * being archived (the archive's 409), or the items keeping a table from being
 * cleared (#74). Either list is `{ id, summary }`.
 */
export async function refusalFrom(response: Response): Promise<Refusal> {
  const body = await response.json().catch(() => undefined);
  const list = body?.bookings ?? body?.items;
  return {
    message:
      typeof body?.error === "string"
        ? body.error
        : "That didn't work. Reload the page and try again.",
    bookings: Array.isArray(list)
      ? list
          .filter(
            (item: { id?: unknown; summary?: unknown }) =>
              typeof item?.id === "string" && typeof item?.summary === "string",
          )
          // A link only to the dashboard's own pages, whatever the body says.
          .map(({ id, summary, href }: { id: string; summary: string; href?: unknown }) => ({
            id,
            summary,
            ...(typeof href === "string" && /^\/dashboard\//.test(href) ? { href } : {}),
          }))
      : [],
    warnings: Array.isArray(body?.confirm?.warnings)
      ? body.confirm.warnings.filter((warning: unknown) => typeof warning === "string")
      : [],
    refresh: body?.refresh === true,
  };
}
