"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useState } from "react";

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
  const [error, setError] = useState<string>();
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
      const response = await fetch(action, { method: "POST", body });
      if (response.ok) {
        if (resetOnSuccess) form.reset();
        setSaved(true);
        router.refresh();
      } else {
        setError(await refusalFrom(response));
      }
    } catch {
      setError("That didn't reach the server. Try again.");
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
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </fieldset>
    </form>
  );
}

async function refusalFrom(response: Response) {
  const body = await response.json().catch(() => undefined);
  return typeof body?.error === "string"
    ? body.error
    : "That didn't work. Reload the page and try again.";
}
