import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "./button";

const square = {
  default: "size-11 px-0",
  staff: "size-12 px-0",
  compact: "size-10 px-0",
} as const;

type IconButtonProps = {
  /** Required: the accessible name, since the button shows only an icon. */
  label: string;
  /** A Lucide icon element, e.g. `<Phone />`. Sized 20px unless it says otherwise. */
  icon: ReactNode;
  variant?: "secondary" | "ghost" | "primary" | "soft" | "danger-ghost";
  /** default 44px, staff 48px, compact 40px. */
  size?: keyof typeof square;
  /** Renders a link instead of a button: next/link for "/..." paths, a plain <a> for tel:, https: and the rest. */
  href?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">;

/** A square button with just an icon (S-41). Server-friendly. */
export function IconButton({
  label,
  icon,
  variant = "secondary",
  size = "staff",
  href,
  className,
  type = "button",
  ...props
}: IconButtonProps) {
  const classes = cn(buttonVariants({ variant, size: "default" }), square[size], className);
  if (href !== undefined) {
    return href.startsWith("/") ? (
      <Link href={href} aria-label={label} title={label} className={classes}>
        {icon}
      </Link>
    ) : (
      <a href={href} aria-label={label} title={label} className={classes}>
        {icon}
      </a>
    );
  }
  return (
    <button type={type} aria-label={label} title={label} className={classes} {...props}>
      {icon}
    </button>
  );
}
