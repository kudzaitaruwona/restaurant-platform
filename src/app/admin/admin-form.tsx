"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

/**
 * Posts to an admin route and keeps what was typed when the route says no, which
 * is the usual case for a taken slug or email.
 */
export function AdminForm({
  action,
  submitLabel,
  children,
}: {
  action: string;
  submitLabel: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setPending(true);
    setError(undefined);
    try {
      const response = await fetch(action, {
        method: "POST",
        body: new FormData(form),
      });
      if (response.ok) {
        form.reset();
        router.refresh();
        return;
      }
      const body = await response.json().catch(() => undefined);
      setError(body?.error ?? "That didn't work. Try again.");
    } catch {
      setError("That didn't work. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      {children}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" size="sm" disabled={pending} className="self-start">
        {submitLabel}
      </Button>
    </form>
  );
}
