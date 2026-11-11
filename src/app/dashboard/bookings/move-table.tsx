"use client";

import { ArrowLeftRight } from "lucide-react";
import { type MouseEvent, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ActionForm } from "../action-form";

export type MoveTarget = { id: string; label: string; capacity: number; walkInOnly: boolean };

/** The More menu's id for a popover opened from inside it, so focus can go back to its trigger. */
const openedFrom = new WeakMap<HTMLElement, string>();

/**
 * "Move to another table" in a booking's More menu. It opens the move dialog
 * (a native popover, so it opens without JavaScript too) and closes the menu
 * first, so the dialog stands on its own. With no table free it is disabled
 * and says why.
 */
export function MoveMenuItem({ dialogId, free }: { dialogId: string; free: number }) {
  const disabled = free === 0;
  function click(event: MouseEvent<HTMLButtonElement>) {
    if (disabled) {
      event.preventDefault();
      return;
    }
    const menu = event.currentTarget.closest<HTMLElement>("[popover]");
    const dialog = document.getElementById(dialogId);
    if (menu && dialog) openedFrom.set(dialog, menu.id);
    if (menu?.matches(":popover-open")) menu.hidePopover();
  }
  return (
    <button
      type="button"
      role="menuitem"
      popoverTarget={disabled ? undefined : dialogId}
      popoverTargetAction="show"
      aria-disabled={disabled || undefined}
      onClick={click}
      className={cn(
        "flex min-h-12 w-full items-center gap-3 rounded-control px-3.5 py-2 text-left text-body font-medium text-ink outline-none hover:bg-surface-2 focus-visible:bg-surface-2 aria-disabled:cursor-not-allowed aria-disabled:opacity-60 [&>svg]:size-5 [&>svg]:shrink-0 [&>svg]:text-ink-2",
      )}
    >
      <ArrowLeftRight aria-hidden />
      <span className="flex min-w-0 flex-col">
        <span>Move to another table</span>
        {disabled && <span className="text-caption font-normal text-ink-2">No other table is free</span>}
      </span>
    </button>
  );
}

/**
 * The move dialog (spec 04, Move table): only the tables free for the whole
 * hold, as radio rows, posted to /api/bookings/{id}/move as `tableId`. It is a
 * plain post without JavaScript. No message goes to the guest. It closes itself
 * once the move lands, which shows as the row's new table.
 */
export function MoveTableDialog({
  id,
  bookingId,
  guestName,
  summary,
  table,
  moves,
}: {
  id: string;
  bookingId: string;
  guestName: string;
  /** "19:00, party of 4" */
  summary: string;
  /** The table it is on now. */
  table: string;
  moves: MoveTarget[];
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const shown = useRef(table);

  useEffect(() => {
    const element = dialog.current;
    if (!element || shown.current === table) return;
    shown.current = table;
    if (element.matches(":popover-open")) element.hidePopover();
  }, [table]);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const toggled = (event: Event) => {
      if ((event as ToggleEvent).newState === "open") {
        element.querySelector<HTMLInputElement>('input[name="tableId"]')?.focus();
        return;
      }
      const menuId = openedFrom.get(element);
      if (menuId) document.querySelector<HTMLElement>(`[popovertarget="${menuId}"]`)?.focus();
    };
    element.addEventListener("toggle", toggled);
    return () => element.removeEventListener("toggle", toggled);
  }, []);

  if (moves.length === 0) return null;
  const titleId = `${id}-title`;
  return (
    <div
      ref={dialog}
      id={id}
      popover="auto"
      role="dialog"
      aria-labelledby={titleId}
      className="m-auto w-[min(26rem,calc(100vw-32px))] rounded-card border-0 bg-surface p-6 text-ink shadow-float backdrop:bg-scrim"
    >
      <h2 id={titleId} className="text-title font-semibold">
        Move {guestName}
      </h2>
      <p className="mt-1 text-body text-ink-2">
        {summary}, now at {table}. These tables are free for the whole booking. The guest gets no message.
      </p>
      <ActionForm action={`/api/bookings/${bookingId}/move`} className="mt-4 flex flex-col gap-1">
        <fieldset className="flex flex-col gap-1">
          <legend className="sr-only">Move to table</legend>
          {moves.map((move, index) => (
            <label
              key={move.id}
              className="flex min-h-13 cursor-pointer items-center gap-3 rounded-control px-3 hover:bg-surface-2 has-checked:bg-brand-soft"
            >
              <input
                type="radio"
                name="tableId"
                value={move.id}
                required
                defaultChecked={index === 0}
                className="size-5 accent-brand"
              />
              <span className="min-w-12 text-lead font-semibold">{move.label}</span>
              <span className="text-body text-ink-2">
                seats {move.capacity}
                {move.walkInOnly ? ", walk-ins" : ""}
              </span>
            </label>
          ))}
        </fieldset>
        <div className="mt-4 flex flex-wrap justify-end gap-3">
          <Button type="button" variant="secondary" size="staff" popoverTarget={id} popoverTargetAction="hide">
            Go back
          </Button>
          <Button type="submit" size="staff">
            Move
          </Button>
        </div>
      </ActionForm>
    </div>
  );
}
