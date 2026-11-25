"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { ConfirmDialog, type ConfirmReason } from "@/components/ui/confirm-dialog";
import { CONFIRMED_FIELD } from "@/lib/confirmation";
import { postForm } from "@/lib/form-response";

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
  savedMessage,
  children,
}: {
  action: string;
  /** Lets a button elsewhere submit it with `form={id}`, e.g. a RowMenuItem. */
  id?: string;
  className?: string;
  confirmation?: string | Confirmation;
  resetOnSuccess?: boolean;
  savedMessage?: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<Refusal>();
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const [asking, setAsking] = useState(false);
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

  async function send(form: HTMLFormElement, confirmed = false) {
    const body = new FormData(form); // before the fieldset disables its controls
    if (confirmed) body.set(CONFIRMED_FIELD, "1");
    setPending(true);
    setError(undefined);
    setSaved(false);
    try {
      const response = await postForm(action, body);
      if (response.ok) {
        if (resetOnSuccess) form.reset();
        setSaved(true);
        router.refresh();
      } else {
        const refusal = await refusalFrom(response);
        if (refusal.warnings.length > 0) {
          setWarnings(refusal.warnings);
          setWarned(true);
        } else {
          setError(refusal);
          if (refusal.refresh) router.refresh();
        }
      }
    } catch {
      setError({ message: "That didn't reach the server. Try again.", bookings: [], warnings: [], refresh: false });
    } finally {
      setPending(false);
    }
  }

  return (
    <form ref={formRef} id={id} method="post" action={action} onSubmit={submit}>
      <fieldset disabled={pending} className={className}>
        {children}
        {saved && savedMessage && (
          <p role="status" className="text-caption text-ink-2">
            {savedMessage}
          </p>
        )}
        {error && (
          <div role="alert" className="text-caption text-danger">
            <p>{error.message}</p>
            {error.bookings.length > 0 && (
              <ul className="list-disc pl-5">
                {error.bookings.map((booking) => (
                  <li key={booking.id}>{booking.summary}</li>
                ))}
              </ul>
            )}
          </div>
        )}
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

type Refusal = {
  message: string;
  bookings: { id: string; summary: string }[];
  /** A 409 that asks first: nothing was saved (lib/confirmation.ts). */
  warnings: string[];
  /** What the page shows is out of date (#95): reload it, keeping the refusal up. */
  refresh: boolean;
};

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
      ? list.filter(
          (item: { id?: unknown; summary?: unknown }) =>
            typeof item?.id === "string" && typeof item?.summary === "string",
        )
      : [],
    warnings: Array.isArray(body?.confirm?.warnings)
      ? body.confirm.warnings.filter((warning: unknown) => typeof warning === "string")
      : [],
    refresh: body?.refresh === true,
  };
}
