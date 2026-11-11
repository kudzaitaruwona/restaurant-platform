"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { cn } from "@/lib/utils";

/**
 * Posts to an admin route and keeps what was typed when the route says no, which
 * is the usual case for a taken slug or email.
 */
export function AdminForm({
  action,
  submitLabel,
  submitVariant = "primary",
  inline = false,
  className,
  children,
}: {
  action: string;
  submitLabel: string;
  submitVariant?: ButtonProps["variant"];
  /** A one-button form sitting in a row (e.g. a checklist item). */
  inline?: boolean;
  /** Lays out the fields (a stack by default). */
  className?: string;
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

  const button = (
    <Button
      type="submit"
      variant={submitVariant}
      size="compact"
      disabled={pending}
      className={inline ? undefined : "self-start"}
    >
      {submitLabel}
    </Button>
  );

  if (inline) {
    return (
      <form onSubmit={submit} className="flex flex-col items-end gap-1">
        {children}
        {button}
        {error && (
          <p role="alert" className="text-caption text-danger">
            {error}
          </p>
        )}
      </form>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className={cn("flex flex-col gap-4", className)}>{children}</div>
      {error && (
        <Notice role="alert" tone="danger">
          {error}
        </Notice>
      )}
      {button}
    </form>
  );
}
