"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { pressable, Reveal } from "../motion";

/**
 * Posts to an admin route and keeps what was typed when the route says no, which
 * is the usual case for a taken slug or email.
 */
export function AdminForm({
  action,
  submitLabel,
  pendingLabel,
  submitVariant = "primary",
  inline = false,
  className,
  children,
}: {
  action: string;
  submitLabel: string;
  /** What the button says while the post is out ("Creating restaurant"). */
  pendingLabel?: string;
  submitVariant?: ButtonProps["variant"];
  /** A one-button form sitting in a row (e.g. a checklist item). */
  inline?: boolean;
  /** Lays out the fields (a stack by default). */
  className?: string;
  children: ReactNode;
}) {
  const router = useRouter();
  // Kept after it's dismissed, so the closing Reveal still has words in it.
  const [message, setMessage] = useState<string>();
  const [showError, setShowError] = useState(false);
  const setError = (next: string | undefined) => {
    if (next) setMessage(next);
    setShowError(Boolean(next));
  };
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
        // Ready for the next one: back to the first field.
        if (!inline) form.querySelector<HTMLElement>("input:not([type=hidden])")?.focus();
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
      aria-busy={pending || undefined}
      className={cn(inline ? undefined : "self-start", pressable)}
    >
      {pending && !inline && (
        <LoaderCircle
          aria-hidden
          className="animate-spin [animation-duration:700ms] motion-reduce:animate-none"
        />
      )}
      {pending ? (pendingLabel ?? submitLabel) : submitLabel}
    </Button>
  );

  if (inline) {
    return (
      <form onSubmit={submit} className="flex flex-col items-end">
        {children}
        {button}
        <Reveal open={showError}>
          <p role={showError ? "alert" : undefined} className="pt-1 text-caption text-danger">
            {message}
          </p>
        </Reveal>
      </form>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="flex flex-col">
        <div className={cn("flex flex-col gap-4", className)}>{children}</div>
        <Reveal open={showError}>
          <div className="pt-4">
            {/* Nothing in the markup until there's something to say. */}
            {message && (
              <Notice role={showError ? "alert" : undefined} tone="danger">
                {message}
              </Notice>
            )}
          </div>
        </Reveal>
      </div>
      {button}
    </form>
  );
}
