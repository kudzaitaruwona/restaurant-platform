"use client";

import { Ellipsis } from "lucide-react";
import Link from "next/link";
import {
  createContext,
  type KeyboardEvent,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "./button";

/** Where focus goes from item `current` of `count` on a key, or undefined if the key isn't ours. */
export function nextMenuIndex(current: number, count: number, key: string) {
  if (count === 0) return undefined;
  switch (key) {
    case "ArrowDown":
      return current < 0 ? 0 : (current + 1) % count;
    case "ArrowUp":
      return current < 0 ? count - 1 : (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return undefined;
  }
}

/**
 * Where a menu of `menu` size goes under (or, without room, over) a trigger at
 * `anchor`, aligned to its end or start edge, inside a viewport with an 8px gutter.
 */
export function menuPosition(
  anchor: { top: number; bottom: number; left: number; right: number },
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
  align: "start" | "end",
) {
  const gutter = 8;
  const gap = 4;
  const left = align === "end" ? anchor.right - menu.width : anchor.left;
  const below = anchor.bottom + gap;
  const top =
    below + menu.height <= viewport.height - gutter
      ? below
      : Math.max(gutter, anchor.top - gap - menu.height);
  return {
    top,
    left: Math.min(Math.max(gutter, left), Math.max(gutter, viewport.width - menu.width - gutter)),
  };
}

const MenuContext = createContext<{ close: () => void }>({ close() {} });

const itemSelector = '[role="menuitem"]:not([aria-disabled="true"])';

/**
 * The "More" menu (S-41): a "..." button that opens a popover of 48px rows.
 * It's a native popover, so it sits above everything, closes on Esc or a tap
 * outside, and opens even before JavaScript loads. Arrow keys, Home and End
 * move between items. Put destructive items last, after a RowMenuSeparator.
 *
 * Items can be links, buttons with onSelect (from a client component), or
 * submit buttons for a form elsewhere on the page (`form="<form id>"`), which
 * is how a server component wires an item to an ActionForm and its
 * confirmation dialog.
 */
export function RowMenu({
  label,
  children,
  align = "end",
  trigger,
  className,
}: {
  /** The trigger's accessible name and the menu's, e.g. "More for Blessing Moyo". */
  label: string;
  children: ReactNode;
  align?: "start" | "end";
  /** Replaces the default 48px "..." icon button's content, e.g. an icon and the word "More". */
  trigger?: ReactNode;
  className?: string;
}) {
  const id = useId();
  const menuId = `${id}menu`;
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const element = menu.current;
    if (!element) return;
    const toggled = (event: Event) => {
      const isOpen = (event as ToggleEvent).newState === "open";
      setOpen(isOpen);
      if (!isOpen || !button.current) return;
      const anchor = button.current.getBoundingClientRect();
      const { top, left } = menuPosition(
        anchor,
        { width: element.offsetWidth, height: element.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
        align,
      );
      Object.assign(element.style, { position: "fixed", inset: "auto", margin: "0", top: `${top}px`, left: `${left}px` });
      element.querySelector<HTMLElement>(itemSelector)?.focus();
    };
    element.addEventListener("toggle", toggled);
    return () => element.removeEventListener("toggle", toggled);
  }, [align]);

  useEffect(() => {
    if (!open) return;
    // It is pinned to where the trigger was; close rather than drift.
    const close = () => menu.current?.hidePopover();
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  function close() {
    menu.current?.hidePopover();
    button.current?.focus();
  }

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>(itemSelector)];
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = nextMenuIndex(current, items.length, event.key);
    if (next === undefined) return;
    event.preventDefault();
    items[next].focus();
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        popoverTarget={menuId}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={trigger ? undefined : label}
        title={trigger ? undefined : label}
        className={cn(
          buttonVariants({ variant: "secondary", size: "staff" }),
          !trigger && "size-12 px-0",
          className,
        )}
      >
        {trigger ?? <Ellipsis aria-hidden />}
      </button>
      <div
        ref={menu}
        id={menuId}
        popover="auto"
        role="menu"
        aria-label={label}
        onKeyDown={keyDown}
        className="w-max max-w-[min(20rem,calc(100vw-16px))] min-w-56 rounded-card border border-line bg-surface p-1.5 text-ink shadow-float"
      >
        <MenuContext value={{ close }}>{children}</MenuContext>
      </div>
    </>
  );
}

const itemClass = (tone: "default" | "danger") =>
  cn(
    "flex min-h-12 w-full items-center gap-3 rounded-control px-3.5 py-2 text-left text-body font-medium no-underline outline-none focus-visible:bg-surface-2 aria-disabled:cursor-not-allowed aria-disabled:opacity-60 [&>svg]:size-5 [&>svg]:shrink-0",
    tone === "danger"
      ? "text-danger hover:bg-danger-soft focus-visible:bg-danger-soft"
      : "text-ink hover:bg-surface-2 [&>svg]:text-ink-2",
  );

/** One row of a RowMenu. Give it exactly one of href, form or onSelect. */
export function RowMenuItem({
  icon,
  tone = "default",
  href,
  form,
  name,
  value,
  onSelect,
  disabled = false,
  hint,
  children,
}: {
  /** A Lucide icon element, e.g. `<ArrowLeftRight />`. */
  icon?: ReactNode;
  tone?: "default" | "danger";
  href?: string;
  /** The id of a form on the page this item submits (e.g. an ActionForm with a confirmation). */
  form?: string;
  name?: string;
  value?: string;
  onSelect?: () => void;
  disabled?: boolean;
  /** A second, quieter line, e.g. why it's disabled: "No other table is free". */
  hint?: ReactNode;
  children: ReactNode;
}) {
  const { close } = useContext(MenuContext);
  const content = (
    <>
      {icon}
      <span className="flex min-w-0 flex-col">
        <span>{children}</span>
        {hint && <span className="text-caption font-normal text-ink-2">{hint}</span>}
      </span>
    </>
  );

  if (href !== undefined && !disabled) {
    return (
      <Link role="menuitem" href={href} className={itemClass(tone)} onClick={close}>
        {content}
      </Link>
    );
  }
  return (
    <button
      role="menuitem"
      type={form ? "submit" : "button"}
      form={form}
      name={name}
      value={value}
      aria-disabled={disabled || undefined}
      className={itemClass(tone)}
      onClick={(event) => {
        if (disabled) {
          event.preventDefault();
          return;
        }
        close(); // first, so a dialog the item opens returns focus to the trigger
        onSelect?.();
      }}
    >
      {content}
    </button>
  );
}

/** The hairline before a menu's destructive items. */
export function RowMenuSeparator() {
  return <div role="separator" className="mx-2 my-1.5 h-px bg-line" />;
}

/** A quiet line at the top of a menu saying what it's for: "1 × Grilled bream, T3". */
export function RowMenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-3.5 pt-1.5 pb-2 text-caption text-ink-2">{children}</div>;
}
