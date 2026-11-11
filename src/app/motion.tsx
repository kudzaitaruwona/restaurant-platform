import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/*
 * Small motion pieces for the sign-in and onboarding screens. CSS only (no
 * client JS of their own), transitions rather than keyframes so a quick change
 * of mind retargets instead of restarting, and calm under reduced motion: the
 * movement goes, the fade stays.
 */

/** A strong ease-out: starts at once, settles softly. */
export const easeOut = "ease-[cubic-bezier(0.23,1,0.32,1)]";

/** Press feedback for buttons: a slight give, not a jump. */
export const pressable =
  "active:translate-y-0 motion-safe:active:not-disabled:scale-[0.97]";

/**
 * Opens and closes its content in place, so a message pushes what's below it
 * down smoothly instead of snapping it. Keeps the last content while closing.
 */
export function Reveal({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div
      aria-hidden={!open}
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-200 motion-reduce:transition-[opacity]",
        easeOut,
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
      )}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

/**
 * One step of a flow. Mount it with a new `key` per step and it arrives with a
 * short fade and a 4px rise (just the fade under reduced motion).
 */
export function StepPanel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        "transition-[opacity,translate] duration-200 starting:opacity-0 motion-safe:starting:translate-y-1",
        easeOut,
        className,
      )}
    >
      {children}
    </div>
  );
}
