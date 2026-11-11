import {
  Ban,
  Check,
  CheckCheck,
  Clock,
  Flame,
  UserCheck,
  UserX,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Every status a pill can show (S-41): an order item's (S-22), a booking's
 * (spec 04), and "late". Colour carries meaning only: positive states are the
 * green accent, voided and cancelled are red, late is amber, the rest neutral.
 * Every pill has a word, and most an icon, so none relies on colour alone.
 */
export type PillStatus =
  | "placed"
  | "cooking"
  | "done"
  | "delivered"
  | "voided"
  | "confirmed"
  | "seated"
  | "completed"
  | "cancelled"
  | "no_show"
  | "late";

const look: Record<PillStatus, { label: string; className: string; icon?: ReactNode }> = {
  placed: { label: "Placed", className: "border border-line bg-transparent text-ink" },
  cooking: { label: "Cooking", className: "bg-ink text-page", icon: <Flame /> },
  done: { label: "Done", className: "bg-accent-soft text-accent", icon: <Check /> },
  delivered: {
    label: "Delivered",
    className: "bg-transparent text-ink-2 [&_svg]:text-accent",
    icon: <CheckCheck />,
  },
  voided: { label: "Voided", className: "bg-danger-soft text-danger", icon: <Ban /> },
  confirmed: { label: "Confirmed", className: "bg-surface-2 text-ink" },
  seated: { label: "Seated", className: "bg-accent-soft text-accent", icon: <UserCheck /> },
  completed: {
    label: "Completed",
    className: "border border-line bg-transparent text-ink-2",
    icon: <Check />,
  },
  cancelled: { label: "Cancelled", className: "bg-danger-soft text-danger", icon: <Ban /> },
  no_show: { label: "No-show", className: "bg-surface-2 text-ink-2", icon: <UserX /> },
  late: {
    label: "Late",
    className: "bg-attention-soft text-attention-ink [&_svg]:text-attention",
    icon: <Clock />,
  },
};

/** A status as a pill: 28px, fully rounded, 13px semibold. Server-friendly. */
export function StatusPill({
  status,
  label,
  className,
}: {
  status: PillStatus;
  /** Overrides the word, e.g. "Served" for delivered on a guest page, or "Late 27 min". */
  label?: string;
  className?: string;
}) {
  const { label: word, className: tone, icon } = look[status];
  return (
    <span
      data-status={status}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-caption font-semibold whitespace-nowrap [&_svg]:size-4 [&_svg]:shrink-0",
        tone,
        className,
      )}
    >
      {icon}
      {label ?? word}
    </span>
  );
}
