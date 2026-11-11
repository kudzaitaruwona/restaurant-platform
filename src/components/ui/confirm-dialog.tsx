"use client";

import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "./button";

/** A reason the person must (or may) type before confirming: void, reject, force-close. */
export type ConfirmReason = {
  label: string;
  /** The field's name, so a dialog inside a <form> posts it. Default "reason". */
  name?: string;
  hint?: ReactNode;
  maxLength?: number;
  /** Checked here, not with the `required` attribute, so the form still posts without JavaScript. */
  required?: boolean;
  placeholder?: string;
};

export type ConfirmDialogProps = {
  open: boolean;
  /** A question: "Cancel this booking?" */
  title: string;
  /** What will happen: "Blessing Moyo, 19:00, party of 4 at T6. Their table is freed." */
  description?: ReactNode;
  /** Says what it does: "Cancel booking", "Void item", never just "OK". */
  confirmLabel: string;
  /** The way back, e.g. "Keep booking". Default "Cancel". */
  cancelLabel?: string;
  /** danger: solid red confirm (default). primary: solid black. */
  tone?: "danger" | "primary";
  reason?: ConfirmReason;
  /** Disables both buttons while the action is under way. */
  pending?: boolean;
  /** Anything else the person needs to see: the items a force-close will void. */
  children?: ReactNode;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
};

/** What's wrong with a typed reason, if anything. */
export function reasonProblem(value: string, reason: ConfirmReason | undefined) {
  if (!reason) return undefined;
  if (reason.required && value.trim() === "") return "Give a reason.";
  if (reason.maxLength !== undefined && value.length > reason.maxLength) {
    return `Keep it to ${reason.maxLength} characters.`;
  }
  return undefined;
}

/**
 * An in-page confirmation (S-41), replacing the browser's confirm(): a native
 * modal <dialog>, so focus is trapped and Esc cancels for free, and focus goes
 * back where it was on close. A tap on the scrim cancels too. Optionally asks
 * for a reason. Rendered inside a <form>, its reason field posts with it; on its
 * own, onConfirm gets the text.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "danger",
  reason,
  pending = false,
  children,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [problem, setProblem] = useState<string>();
  const id = useId();

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      element.showModal();
    } else if (!open && element.open) {
      element.close();
    }
  }, [open]);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const cancel = (event: Event) => {
      event.preventDefault(); // stay in charge of `open`
      if (!pending) onCancel();
    };
    const closed = () => setProblem(undefined);
    element.addEventListener("cancel", cancel);
    element.addEventListener("close", closed);
    return () => {
      element.removeEventListener("cancel", cancel);
      element.removeEventListener("close", closed);
    };
  }, [onCancel, pending]);

  function confirm() {
    const value = field.current?.value ?? "";
    const wrong = reasonProblem(value, reason);
    setProblem(wrong);
    if (wrong) {
      field.current?.focus();
      return;
    }
    onConfirm(value.trim());
  }

  return (
    <dialog
      ref={dialog}
      aria-labelledby={`${id}title`}
      aria-describedby={description ? `${id}desc` : undefined}
      className="ui-dialog m-auto w-[min(440px,calc(100vw-32px))] max-w-none rounded-card border-0 bg-surface p-6 text-body text-ink shadow-float"
      onClick={(event) => {
        if (event.target === event.currentTarget && !pending) onCancel();
      }}
    >
      <h2 id={`${id}title`} className="text-title font-semibold">
        {title}
      </h2>
      {description && (
        <div id={`${id}desc`} className="mt-2 text-ink-2">
          {description}
        </div>
      )}
      {children && <div className="mt-4">{children}</div>}
      {reason && (
        <div className="mt-4 flex flex-col gap-1.5">
          <label htmlFor={`${id}reason`} className="text-caption font-medium text-ink-2">
            {reason.label}
          </label>
          <textarea
            ref={field}
            id={`${id}reason`}
            name={reason.name ?? "reason"}
            rows={3}
            maxLength={reason.maxLength}
            placeholder={reason.placeholder}
            aria-invalid={problem ? true : undefined}
            aria-describedby={`${id}reasonhint`}
            className="min-h-24 w-full resize-y rounded-control border border-line bg-surface px-3 py-2.5 text-body text-ink outline-none placeholder:text-ink-2 focus:border-ring focus:ring-2 focus:ring-ring/30 aria-invalid:border-danger"
          />
          <p id={`${id}reasonhint`} className={cn("text-caption", problem ? "text-danger" : "text-ink-2")}>
            {problem ?? reason.hint}
          </p>
        </div>
      )}
      <div className="mt-6 flex flex-wrap justify-end gap-3">
        <Button type="button" variant="secondary" size="staff" disabled={pending} onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button
          type="button"
          variant={tone === "danger" ? "danger" : "primary"}
          size="staff"
          disabled={pending}
          onClick={confirm}
        >
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
