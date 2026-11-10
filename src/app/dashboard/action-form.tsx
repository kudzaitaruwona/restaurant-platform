"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useState } from "react";
import { postForm } from "@/lib/form-response";

/**
 * A form that posts to a route handler and shows the refusal in place, keeping
 * what was typed. Without JavaScript it's still a plain post.
 */
export function ActionForm({
  action,
  className,
  confirmation,
  resetOnSuccess = false,
  savedMessage,
  children,
}: {
  action: string;
  className?: string;
  confirmation?: string;
  resetOnSuccess?: boolean;
  savedMessage?: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const [error, setError] = useState<Refusal>();
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (confirmation && !window.confirm(confirmation)) return;

    const form = event.currentTarget;
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
    <form method="post" action={action} onSubmit={submit}>
      <fieldset disabled={pending} className={className}>
        {children}
        {saved && savedMessage && (
          <p role="status" className="text-sm text-muted-foreground">
            {savedMessage}
          </p>
        )}
        {error && (
          <div role="alert" className="text-sm text-destructive">
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
