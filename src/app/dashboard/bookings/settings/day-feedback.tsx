"use client";

import { createContext, type ComponentProps, type ReactNode, useContext, useState } from "react";
import { ActionForm } from "../../action-form";

const Say = createContext<(message: string) => void>(() => {});

/**
 * A day's block on the settings screen. Deleting a period removes the row the
 * form's own "Deleted" would have shown in, so the message lives here, which
 * stays put, and the delete forms inside it report to it.
 */
export function DayFeedback({ className, children }: { className?: string; children: ReactNode }) {
  const [message, setMessage] = useState<string>();
  return (
    <Say value={setMessage}>
      <div className={className}>
        {children}
        {message && (
          <p role="status" className="text-caption text-ink-2">
            {message}
          </p>
        )}
      </div>
    </Say>
  );
}

/** A delete form that says what it did in its day's block. */
export function DeletePeriodForm({
  deletedMessage,
  ...props
}: Omit<ComponentProps<typeof ActionForm>, "onSaved" | "savedMessage"> & { deletedMessage: string }) {
  const say = useContext(Say);
  return <ActionForm {...props} onSaved={() => say(deletedMessage)} />;
}
