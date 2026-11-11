"use client";

import {
  Armchair,
  Banknote,
  BookOpen,
  CalendarCog,
  CalendarDays,
  ChefHat,
  LayoutGrid,
  type LucideIcon,
  Menu,
  Settings,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { activeItem, initialsOf, type NavKey, navFor } from "./nav";

const icons: Record<NavKey, LucideIcon> = {
  kitchen: ChefHat,
  floor: LayoutGrid,
  bookings: CalendarDays,
  menu: BookOpen,
  tables: Armchair,
  bookingSettings: CalendarCog,
  settings: Settings,
  staff: Users,
};

/** The page's primary action goes here on a phone; see StaffTopBarAction. */
export const TOP_BAR_ACTION_ID = "staff-top-bar-action";

/** The owner's exchange rate (S-26), as the dashboard showed it. */
export type RailRate = {
  /** "26.8", or null with none set. */
  value: string | null;
  /** "2 days ago", or null with none set. */
  age: string | null;
  /** More than 7 days old (spec 02). */
  stale: boolean;
};

export type StaffNavigationProps = {
  restaurantName: string;
  role: "owner" | "staff";
  /** Who is signed in: a name and a quiet line under it ("Owner"). */
  person: { name: string; detail: string };
  /** Owners only. */
  rate?: RailRate;
  /** Sign out, or the dev switcher in development: the rail's last slot. */
  session: ReactNode;
};

/**
 * The staff shell's navigation (S-41, 5-bookings-shell.md): a 64px icon rail
 * from 768px up that expands to 240px over the page on hover, keyboard focus
 * or a tap on the restaurant mark, and below 768px a 56px top bar whose menu
 * opens the same panel as a drawer.
 */
export function StaffNavigation(props: StaffNavigationProps) {
  const pathname = usePathname() ?? "";
  const current = activeItem(pathname);
  return (
    <>
      <StaffRail {...props} current={current?.key} />
      <StaffTopBar {...props} current={current?.key} title={current?.label ?? props.restaurantName} />
    </>
  );
}

function StaffRail({ current, ...props }: StaffNavigationProps & { current?: NavKey }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative z-40 hidden md:block print:hidden">
      {open && (
        // While open on touch, a tap outside closes it and goes no further, so
        // it can't press Seat or Cancel underneath.
        <div aria-hidden className="fixed inset-0" onClick={() => setOpen(false)} />
      )}
      <nav
        aria-label="Staff"
        data-open={open}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          setOpen(false);
          if (event.target instanceof HTMLElement) event.target.blur();
        }}
        className="staff-rail sticky top-[var(--admin-bar)] flex h-[calc(100dvh-var(--admin-bar))] flex-col overflow-hidden border-r border-line bg-surface"
      >
        <div className="flex h-16 shrink-0 items-center gap-3 px-3">
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${props.restaurantName}, ${open ? "hide" : "show"} navigation labels`}
            onClick={() => setOpen(!open)}
            className="grid size-10 shrink-0 place-items-center rounded-control bg-brand text-body font-[650] tracking-[0.02em] text-brand-ink outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          >
            {initialsOf(props.restaurantName)}
          </button>
          <Link
            href="/dashboard"
            onClick={() => setOpen(false)}
            className="rail-fade min-w-0 truncate rounded-sm text-lead font-semibold text-ink outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {props.restaurantName}
          </Link>
        </div>
        <NavList role={props.role} current={current} variant="rail" onNavigate={() => setOpen(false)} />
        <Foot {...props} variant="rail" onNavigate={() => setOpen(false)} />
      </nav>
    </div>
  );
}

function StaffTopBar({
  current,
  title,
  ...props
}: StaffNavigationProps & { current?: NavKey; title: string }) {
  const drawer = useRef<HTMLDialogElement>(null);
  const close = () => drawer.current?.close();
  return (
    <div className="sticky top-[var(--admin-bar)] z-30 flex h-14 items-center gap-1 border-b border-line bg-surface px-1 md:hidden print:hidden">
      <button
        type="button"
        aria-label="Open navigation"
        aria-haspopup="dialog"
        onClick={() => drawer.current?.showModal()}
        className="grid size-12 shrink-0 place-items-center rounded-control text-ink outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-6"
      >
        <Menu aria-hidden />
      </button>
      <p className="min-w-0 flex-1 truncate pl-1 text-lead font-semibold text-ink">{title}</p>
      <div id={TOP_BAR_ACTION_ID} className="flex shrink-0 items-center" />
      <dialog
        ref={drawer}
        aria-label="Navigation"
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
        className="staff-drawer fixed inset-y-0 right-auto left-0 m-0 h-dvh max-h-none w-[min(288px,85vw)] max-w-none bg-surface p-0 text-body text-ink shadow-float"
      >
        <div className="flex h-full flex-col">
          <div className="flex h-16 shrink-0 items-center gap-3 pr-2 pl-3">
            <span
              aria-hidden
              className="grid size-10 shrink-0 place-items-center rounded-control bg-brand text-body font-[650] tracking-[0.02em] text-brand-ink"
            >
              {initialsOf(props.restaurantName)}
            </span>
            <Link
              href="/dashboard"
              onClick={close}
              className="min-w-0 flex-1 truncate text-lead font-semibold text-ink outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {props.restaurantName}
            </Link>
            <button
              type="button"
              aria-label="Close navigation"
              onClick={close}
              className="grid size-12 shrink-0 place-items-center rounded-control text-ink outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-6"
            >
              <X aria-hidden />
            </button>
          </div>
          <NavList role={props.role} current={current} variant="drawer" onNavigate={close} />
          <Foot {...props} variant="drawer" onNavigate={close} />
        </div>
      </dialog>
    </div>
  );
}

type Variant = "rail" | "drawer";

/** Hidden in the expanded rail and the drawer; shown in the collapsed rail. */
const collapsedOnly = (variant: Variant) => (variant === "rail" ? "rail-collapsed-only" : "hidden");
/** Faded in as the rail expands; always shown in the drawer. */
const label = (variant: Variant) => (variant === "rail" ? "rail-fade" : "");

function NavList({
  role,
  current,
  variant,
  onNavigate,
}: {
  role: "owner" | "staff";
  current?: NavKey;
  variant: Variant;
  onNavigate: () => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pt-1 pb-2">
      {navFor(role).map(({ group, items }, index) => (
        <div key={group} role="group" aria-label={group}>
          <div className={cn("relative flex h-8 items-center pl-5", index > 0 && "mt-2")}>
            <span aria-hidden className={cn("absolute left-5 h-px w-6 bg-line", collapsedOnly(variant))} />
            <span aria-hidden className={cn("text-caption font-medium text-ink-2", label(variant))}>
              {group}
            </span>
          </div>
          {items.map(({ key, href, label: text }) => {
            const Icon = icons[key];
            const active = key === current;
            return (
              <Link
                key={key}
                href={href}
                aria-current={active ? "page" : undefined}
                onClick={onNavigate}
                className={cn(
                  "relative mx-2 my-0.5 flex h-12 items-center gap-3.5 rounded-control px-3 text-body font-medium no-underline outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "bg-brand-soft font-semibold text-ink before:absolute before:top-3 before:bottom-3 before:-left-2 before:w-[3px] before:rounded-r-full before:bg-accent"
                    : "text-ink-2 hover:bg-surface-2 hover:text-ink",
                )}
              >
                <Icon aria-hidden className="size-[22px] shrink-0" strokeWidth={1.75} />
                <span className={label(variant)}>{text}</span>
              </Link>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function Foot({
  person,
  rate,
  session,
  variant,
  onNavigate,
}: StaffNavigationProps & { variant: Variant; onNavigate: () => void }) {
  return (
    <div className="shrink-0 border-t border-line py-2">
      {rate && <Rate rate={rate} variant={variant} onNavigate={onNavigate} />}
      <div className="flex h-14 items-center gap-3 px-3">
        <span
          aria-hidden
          className="grid size-10 shrink-0 place-items-center rounded-full bg-brand-soft text-caption font-[650] text-ink"
        >
          {initialsOf(person.name)}
        </span>
        <span className={cn("min-w-0 flex-1", label(variant))}>
          <span className="block truncate text-body leading-tight font-semibold text-ink">{person.name}</span>
          <span className="block truncate text-caption text-ink-2">{person.detail}</span>
        </span>
      </div>
      {session}
    </div>
  );
}

function Rate({ rate, variant, onNavigate }: { rate: RailRate; variant: Variant; onNavigate: () => void }) {
  const unset = rate.value === null;
  const warn = unset || rate.stale;
  const said = unset
    ? "No exchange rate is set. Set one on the Menu page."
    : `Exchange rate 1 USD = ZiG ${rate.value}, updated ${rate.age}.${rate.stale ? " More than 7 days old." : ""} Change it on the Menu page.`;
  return (
    <Link
      href="/dashboard/menu"
      aria-label={said}
      onClick={onNavigate}
      className="mx-2 flex min-h-14 items-center gap-3.5 rounded-control px-3 py-1.5 text-ink-2 no-underline outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="-ml-px flex w-6 shrink-0 flex-col items-center">
        <Banknote aria-hidden className={cn("size-5", warn && "text-attention")} strokeWidth={1.75} />
        <small
          className={cn(
            "mt-px text-caption font-semibold tracking-[-0.01em] tabular-nums",
            warn ? "text-attention-ink" : "text-ink",
            collapsedOnly(variant),
          )}
        >
          {unset ? "Set" : rate.value}
        </small>
      </span>
      <span className={cn("min-w-0", label(variant))}>
        <span className="block text-body font-medium text-ink tabular-nums">
          {unset ? "No exchange rate" : `1 USD = ZiG ${rate.value}`}
        </span>
        <span className={cn("block text-caption", warn && "text-attention-ink")}>
          {unset ? "Set one on the Menu page" : `Updated ${rate.age}. Change`}
        </span>
      </span>
    </Link>
  );
}
