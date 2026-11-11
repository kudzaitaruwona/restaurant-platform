import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/** The card surface (S-41): white (dark grey in dark), hairline, 14px radius. */
export const cardClassName = "rounded-card border border-line bg-surface text-ink";

/**
 * A card. Group with spacing and hairlines first; reach for a card when a block
 * needs to stand apart (a list panel, a ticket, a form section). No shadow: only
 * floating things get one. Server-friendly.
 */
export function Card({
  as: Tag = "div",
  className,
  ...props
}: { as?: "div" | "section" | "article" | "li" | "aside" } & HTMLAttributes<HTMLElement>) {
  return <Tag className={cn(cardClassName, className)} {...props} />;
}

/** Rows inside a card, divided by hairlines (e.g. the bookings list). */
export function CardRows({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("divide-y divide-line", className)} {...props} />;
}
