"use client";

import { useRouter } from "next/navigation";
import {
  type FormEvent,
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import { Notice } from "@/components/ui/notice";
import { ConfirmDialog, type ConfirmReason } from "@/components/ui/confirm-dialog";
import { CONFIRMED_FIELD } from "@/lib/confirmation";
import { postForm } from "@/lib/form-response";
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
  onSaved,
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
  /** Called after a save, for a form whose own message goes with it (a deleted row). */
  onSaved?: () => void;
  /** Reloads the page's data after a refusal too, for a form whose page shows what the refusal found out (a stale list). */
  refreshOnRefusal?: boolean;
  children: ReactNode;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<Refusal>();
  const [saved, setSaved] = useState(false);
  const page = useContext(PageRefusalContext);
  const [detail, setDetail] = useState<SavedDetail>();
  const [pending, setPending] = useState(false);
  const [asking, setAsking] = useState(false);
  const [self] = useState(() => Symbol("action-form"));
  // One refusal on the page at a time: sending another form clears this one's. A
  // warning isn't a refusal: its dialog is modal, and answering it sends again.
  useEffect(() => clearOnOtherSend(self, () => setError(undefined)), [self]);
  // What the server wants the person to see before it saves (lib/confirmation.ts).
  // Kept after it closes, so the dialog stays mounted and closes itself.
  const [warnings, setWarnings] = useState<string[]>([]);
  const [warned, setWarned] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const ask = confirmation === undefined ? undefined : confirmationOf(confirmation);

  // The dialog opens after the post, whose disabled fieldset has already taken
  // focus from the button, so closing it has nothing to return to: put it back.
  useEffect(() => {
    if (!warned) opener.current?.focus();
  }, [warned]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Enter in a field submits too. Safari doesn't focus a clicked button.
    const focused = document.activeElement;
    opener.current =
      focused instanceof HTMLElement && event.currentTarget.contains(focused)
        ? focused
        : (event.nativeEvent as SubmitEvent).submitter;
    if (ask) setAsking(true);
    else void send(event.currentTarget);
  }

  function refuse(refusal: Refusal) {
    if (page && refusalPlace(refusal, { page: true, onPage: refusalOnPage }) === "page") return page.show(refusal);
    setError(refusal);
    if (refusal.refresh) router.refresh();
  }

  async function send(form: HTMLFormElement, confirmed = false) {
    const body = new FormData(form); // before the fieldset disables its controls
    announceSend(self);
    if (confirmed) body.set(CONFIRMED_FIELD, "1");
    setPending(true);
    setError(undefined);
    setSaved(false);
    setDetail(undefined);
    try {
      const response = await postForm(action, body);
      if (response.ok) {
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
        setDetail(await savedFrom(response));
        setSaved(true);
        onSaved?.();
        router.refresh();
      } else {
        const refusal = await refusalFrom(response);
        if (refusal.warnings.length > 0) {
          setWarnings(refusal.warnings);
          setWarned(true);
        } else {
          refuse(refusal);
          if (refreshOnRefusal && !refusal.refresh) router.refresh();
        }
      }
    } catch {
      refuse({ message: "That didn't reach the server. Try again.", bookings: [], warnings: [], refresh: false });
    } finally {
      setPending(false);
    }
  }

  return (
    <form ref={formRef} id={id} method="post" action={action} onSubmit={submit}>
      <fieldset disabled={pending} className={className}>
        {children}
        {saved && detail && (
          <div role="status" className="flex flex-col gap-2">
            <Notice tone="positive">
              {detail.message}
              {detail.href && (
                <>
                  {" "}
                  {/* A full load, so the day's row is the page's :target. */}
                  <a href={detail.href} className="font-semibold underline underline-offset-2">
                    {detail.linkLabel ?? "View"}
                  </a>
                </>
              )}
            </Notice>
            {detail.warning && <Notice tone="attention">{detail.warning}</Notice>}
          </div>
        )}
        {saved && !detail && savedMessage && (
          <p role="status" className="text-caption text-ink-2">
            {savedMessage}
          </p>
        )}
        {error && <RefusalAlert refusal={error} />}
      </fieldset>
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
  { refusal: Refusal | undefined; refreshing: boolean; show: (refusal: Refusal) => void } | undefined
>(undefined);

/**
 * Gives a page a place of its own for refusals (#102): a stale form's, which
 * reloads the page and may take the form with it, and those of forms with
 * `refusalOnPage`. They show where PageRefusalAlert is.
 */
export function PageRefusals({ className, children }: { className?: string; children: ReactNode }) {
  const router = useRouter();
  const [store] = useState(pageRefusal);
  const refusal = useSyncExternalStore(store.subscribe, store.get, () => undefined);
  const [refreshing, startRefresh] = useTransition();
  function show(next: Refusal) {
    store.show(next);
    if (next.refresh) startRefresh(() => router.refresh());
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

/** What a save says about itself, when the route answers with more than a 204. */
type SavedDetail = { message: string; href?: string; linkLabel?: string; warning?: string };

/**
 * A save that answers 200 with `{ saved: { message, href?, linkLabel?, warning? } }`
 * shows that instead of the form's fixed message. The link goes only to the
 * dashboard's own pages, whatever the body says.
 */
export async function savedFrom(response: Response): Promise<SavedDetail | undefined> {
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
