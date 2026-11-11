"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useRef, useState } from "react";
import { ConfirmDialog, type ConfirmReason } from "@/components/ui/confirm-dialog";
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
  const ask = confirmation === undefined ? undefined : confirmationOf(confirmation);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (ask) setAsking(true);
    else void send(event.currentTarget);
  }

  async function send(form: HTMLFormElement) {
    const body = new FormData(form); // before the fieldset disables its controls
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
        setError(await refusalFrom(response));
      }
    } catch {
      setError({ message: "That didn't reach the server. Try again.", bookings: [] });
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

type Refusal = { message: string; bookings: { id: string; summary: string }[] };

/**
 * A refusal says why, and may list what is in the way: the bookings on a table
 * being archived (the archive's 409), or the items keeping a table from being
 * cleared (#74). Either list is `{ id, summary }`.
 */
async function refusalFrom(response: Response): Promise<Refusal> {
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
  };
}
