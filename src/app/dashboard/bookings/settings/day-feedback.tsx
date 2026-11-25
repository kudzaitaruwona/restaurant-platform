"use client";

import { createContext, type ComponentProps, type ReactNode, useContext, useEffect, useState } from "react";
import { ActionForm } from "../../action-form";
import { clearOnOtherSend } from "../../refusals";

export const Say = createContext<(message: string) => void>(() => {});

/**
 * Clears a message when any form on the page is sent, so it never sits beside a
 * newer answer. Its own delete's send comes before the save that sets it. Stopping
 * (the page left, or hidden and kept) clears it too.
 */
export function clearWithSends(clear: () => void) {
  const off = clearOnOtherSend(Symbol("day-feedback"), clear);
  return () => {
    off();
    clear();
  };
}

/**
 * A day's block on the settings screen. Deleting a period removes the row the
 * form's own "Deleted" would have shown in, so the message lives here, which
 * stays put, and the delete forms inside it report to it.
 */
export function DayFeedback({ className, children }: { className?: string; children: ReactNode }) {
  const [message, setMessage] = useState<string>();
  useEffect(() => {
    const stop = clearWithSends(() => setMessage(undefined));
    return () => stop();
  }, []);
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
