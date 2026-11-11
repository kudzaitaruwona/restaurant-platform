import { Bell } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The bell on a table calling a waiter (S-41), with a ring that pulses: the
 * only idle animation on the floor, and off under reduced motion.
 */
export function CallingBell() {
  return (
    <span className="relative inline-grid shrink-0">
      <Bell aria-hidden className="size-5" />
      <span
        aria-hidden
        className="absolute -inset-1 rounded-full border-2 border-attention opacity-0 motion-safe:animate-ping motion-safe:opacity-60 motion-safe:[animation-duration:2.4s]"
      />
    </span>
  );
}

/** Dismiss on a waiter call: 48px, amber outline on a white (dark grey) fill. */
export const dismissButtonClassName = cn(
  buttonVariants({ variant: "secondary", size: "staff" }),
  "border-attention bg-surface text-attention-ink hover:bg-surface-2",
);
