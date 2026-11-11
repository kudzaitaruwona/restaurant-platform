import {
  Ban,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  MessageCircle,
  Phone,
  Plus,
  StickyNote,
  TriangleAlert,
  Users,
  UserX,
} from "lucide-react";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { cardClassName } from "@/components/ui/card";
import { IconButton } from "@/components/ui/icon-button";
import { inputClassName } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { RowMenu, RowMenuItem, RowMenuSeparator } from "@/components/ui/row-menu";
import { StatusPill } from "@/components/ui/status-pill";
import { getDayView } from "@/lib/booking-day";
import { contactLinks, type DayRow } from "@/lib/booking-day-view";
import { getMoveTargets } from "@/lib/booking-staff";
import { getTenantContext } from "@/lib/tenant";
import { cn } from "@/lib/utils";
import { walkInTables } from "@/lib/walk-in";
import { ActionForm } from "../action-form";
import { StaffTopBarAction } from "../shell/top-bar-action";
import { MoveMenuItem, MoveTableDialog, type MoveTarget } from "./move-table";
import { WalkInForm } from "./walk-in-form";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** "Thursday 12 November": a calendar date, so it is formatted as one, in no zone. */
const longDate = (date: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(`${date}T00:00:00Z`));

const sourceLabel = { online: "Online", staff: "Added by staff" } as const;

/** Time | guest | party | table | status | actions from 768px; stacked on a phone. */
const rowGrid =
  "grid grid-cols-[3rem_minmax(0,1fr)_auto] gap-x-3 md:grid-cols-[72px_minmax(0,1fr)_76px_64px_140px_264px] md:gap-x-4";

/**
 * The day view (spec 04) for anyone on the team (S-26): a day's bookings by
 * service period, with the status actions. Every time on it is the restaurant's.
 * Phones are in the markup only because the viewer is that restaurant's staff.
 * Each row has one main action (Seat or Finish); Move, No-show and Cancel sit
 * behind More, and No-show and Cancel ask first (S-41).
 */
export async function BookingsScreen({
  searchParams,
}: {
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const tenant = await getTenantContext();
  const query = (await searchParams) ?? {};
  const day = await getDayView(tenant, query.date);
  const moves = await getMoveTargets(tenant, day.date);
  // A walk-in sits down now, so the form is for today only.
  const tables = day.isToday ? await walkInTables(tenant) : [];
  const addHref = `/dashboard/bookings/new?date=${day.date}`;
  const empty = day.groups.every((group) => group.rows.length === 0);

  return (
    <>
      {/* On a phone the top bar already says Bookings and holds Add booking. */}
      <PageHeader
        title="Bookings"
        className="max-md:sr-only"
        actions={
          <Link
            href={addHref}
            className={cn(buttonVariants({ variant: "primary", size: "staff" }), "hidden md:inline-flex")}
          >
            <Plus aria-hidden />
            Add booking
          </Link>
        }
      />
      <StaffTopBarAction>
        <IconButton label="Add booking" icon={<Plus />} href={addHref} variant="ghost" />
      </StaffTopBarAction>

      <nav
        aria-label="Choose a day"
        className={cn(cardClassName, "flex flex-wrap items-center gap-x-3 gap-y-1 p-1 md:p-2")}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1 md:gap-2">
          <IconButton
            label="Previous day"
            icon={<ChevronLeft />}
            href={`/dashboard/bookings?date=${day.previous}`}
            variant="ghost"
          />
          <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5 px-1 sm:flex-row sm:items-center sm:gap-3">
            <h2 className="max-w-full truncate text-lead font-semibold tracking-[-0.01em] md:text-title">
              {longDate(day.date)}
            </h2>
            {day.isToday && (
              <span className="inline-flex h-6 items-center rounded-full bg-brand-soft px-2.5 text-caption font-semibold text-ink md:h-7 md:px-3">
                Today
              </span>
            )}
          </div>
          {!day.isToday && (
            <Link href="/dashboard/bookings" className={buttonVariants({ variant: "secondary", size: "staff" })}>
              Today
            </Link>
          )}
          <IconButton
            label="Next day"
            icon={<ChevronRight />}
            href={`/dashboard/bookings?date=${day.next}`}
            variant="ghost"
          />
        </div>
        <form
          method="get"
          action="/dashboard/bookings"
          className="flex w-full items-center gap-2 px-1 pb-1 md:w-auto md:p-0"
        >
          <label htmlFor="go-to-date" className="sr-only">
            Go to date
          </label>
          <input
            id="go-to-date"
            type="date"
            name="date"
            defaultValue={day.date}
            required
            className={cn(inputClassName, "flex-1 tabular-nums md:w-44 md:flex-none")}
          />
          <Button type="submit" variant="secondary" size="staff">
            Show
          </Button>
        </form>
      </nav>

      {day.refused && <Notice role="status">That date wasn&apos;t usable, so this is today.</Notice>}

      <WalkInForm tables={tables} />

      {empty ? (
        <div className="flex flex-col items-start gap-3 px-2 pt-8 pb-6">
          <CalendarDays aria-hidden className="size-8 text-ink-2" />
          <p className="text-lead font-semibold">No bookings on this day.</p>
          <Link href={addHref} className={buttonVariants({ variant: "soft", size: "staff" })}>
            <Plus aria-hidden />
            Add booking
          </Link>
        </div>
      ) : (
        day.groups.map((group) => (
          <section key={group.name} aria-label={group.name} className="flex flex-col gap-2.5">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 className="text-title font-semibold tracking-[-0.01em]">{group.name}</h2>
              <span className="text-body font-medium tabular-nums">
                {plural(group.bookingCount, "booking")}, {plural(group.covers, "cover")}
              </span>
              <span className="text-caption text-ink-2">
                {group.rows.length === 0 ? "No bookings." : "Cancelled and no-shows not counted"}
              </span>
            </div>
            {group.rows.length > 0 && (
              <div className={cn(cardClassName, "overflow-hidden")}>
                <div
                  aria-hidden="true"
                  className={cn(
                    rowGrid,
                    "hidden h-9 items-center border-b border-line bg-surface-2 pr-4 pl-5 text-caption text-ink-2 md:grid",
                  )}
                >
                  <span>Time</span>
                  <span>Guest</span>
                  <span>Party</span>
                  <span>Table</span>
                  <span>Status</span>
                  <span />
                </div>
                <ul className="divide-y divide-line">
                  {group.rows.map((row) => (
                    <BookingRow key={row.id} row={row} moves={moves[row.id] ?? []} />
                  ))}
                </ul>
              </div>
            )}
          </section>
        ))
      )}
    </>
  );
}

function BookingRow({ row, moves }: { row: DayRow; moves: MoveTarget[] }) {
  const links = contactLinks(row.phone);
  const closed = row.status === "cancelled" || row.status === "no_show";
  const confirmed = row.status === "confirmed";
  const summary = `${row.time}, party of ${row.partySize}`;
  const ids = { noShow: `no-show-${row.id}`, cancel: `cancel-${row.id}`, move: `move-${row.id}` };
  const freed = `${row.guestName}, ${summary} at ${row.table}. Their table is freed.`;

  return (
    <li
      className={cn(
        rowGrid,
        "items-start px-4 py-3.5 md:min-h-20 md:items-center md:py-3 md:pr-4 md:pl-5",
        row.confirmationFailed && "bg-[color-mix(in_srgb,var(--attention-soft)_35%,var(--surface))]",
      )}
    >
      <span className={cn("text-lead font-semibold tabular-nums md:text-title", closed && "text-ink-2")}>
        {row.time}
      </span>

      <div className="flex min-w-0 flex-col gap-1 break-words">
        <p className="text-lead leading-snug font-semibold">
          <span className={closed ? "text-ink-2 line-through decoration-1" : undefined}>{row.guestName}</span>
          <span className="ml-2 hidden text-caption font-normal text-ink-2 md:inline">
            {sourceLabel[row.source]}
          </span>
        </p>
        <p className="text-caption text-ink-2 tabular-nums md:hidden">
          Party of {row.partySize}, table {row.table}, {row.source === "online" ? "online" : "added by staff"}
        </p>
        {row.note && (
          <p className="flex items-start gap-1.5 text-body">
            <StickyNote aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-2" />
            <span className="sr-only">Note: </span>
            <span className="min-w-0 break-words">{row.note}</span>
          </p>
        )}
        {row.confirmationFailed && (
          <span
            role="img"
            aria-label="WhatsApp confirmation failed: call the guest"
            title="WhatsApp confirmation failed: call the guest"
            className="mt-0.5 inline-flex items-center gap-2 self-start rounded-full bg-attention-soft py-1 pr-3 pl-2 text-caption font-medium text-ink"
          >
            <TriangleAlert aria-hidden className="size-4 shrink-0 text-attention" />
            WhatsApp confirmation failed. Call the guest.
          </span>
        )}
      </div>

      <span
        className={cn(
          "hidden items-center gap-1.5 text-lead font-semibold tabular-nums md:flex",
          closed && "text-ink-2",
        )}
      >
        <Users aria-hidden className="size-4 text-ink-2" />
        <span className="sr-only">Party of </span>
        {row.partySize}
      </span>
      <span className={cn("hidden text-lead font-semibold md:block", closed && "text-ink-2")}>
        <span className="sr-only">Table </span>
        {row.table}
      </span>

      <div className="flex flex-col items-end gap-1.5 md:flex-row md:flex-wrap md:items-center">
        <StatusPill status={row.status} />
        {row.late && <StatusPill status="late" />}
      </div>

      <div className="col-span-full mt-3 flex items-center gap-2 empty:hidden md:col-span-1 md:mt-0 md:justify-end [&>form]:flex-1 md:[&>form]:flex-none">
        {links && (
          <>
            <IconButton
              label={`Call ${row.guestName}`}
              icon={<Phone />}
              href={links.tel}
              className={row.confirmationFailed ? "border-attention" : undefined}
            />
            <a
              href={links.whatsapp}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`WhatsApp ${row.guestName}`}
              title={`WhatsApp ${row.guestName}`}
              className={cn(buttonVariants({ variant: "secondary", size: "default" }), "size-12 px-0")}
            >
              <MessageCircle aria-hidden />
            </a>
          </>
        )}
        {confirmed && (
          <ActionForm action={`/api/bookings/${row.id}/seat`} className="flex">
            <Button type="submit" variant="soft" size="staff" className="w-full md:min-w-24">
              Seat
            </Button>
          </ActionForm>
        )}
        {row.status === "seated" && (
          <ActionForm action={`/api/bookings/${row.id}/finish`} className="flex">
            <Button type="submit" variant="soft" size="staff" className="w-full md:min-w-24">
              Finish
            </Button>
          </ActionForm>
        )}
        {confirmed && (
          <RowMenu label={`More for ${row.guestName}`}>
            <MoveMenuItem dialogId={ids.move} free={moves.length} />
            <RowMenuItem icon={<UserX />} form={ids.noShow}>
              Mark no-show
            </RowMenuItem>
            <RowMenuSeparator />
            <RowMenuItem icon={<Ban />} tone="danger" form={ids.cancel}>
              Cancel booking
            </RowMenuItem>
          </RowMenu>
        )}
      </div>

      {/* The menu's forms: a refusal shows across the row; empty, they take no room. */}
      {confirmed && (
        <div className="col-span-full">
          <ActionForm
            id={ids.noShow}
            action={`/api/bookings/${row.id}/no-show`}
            className="pt-2 empty:hidden"
            confirmation={{
              title: "Mark as a no-show?",
              description: freed,
              confirmLabel: "Mark no-show",
              cancelLabel: "Keep booking",
            }}
          >
            {null}
          </ActionForm>
          <ActionForm
            id={ids.cancel}
            action={`/api/bookings/${row.id}/cancel`}
            className="pt-2 empty:hidden"
            confirmation={{
              title: "Cancel this booking?",
              description: freed,
              confirmLabel: "Cancel booking",
              cancelLabel: "Keep booking",
            }}
          >
            {null}
          </ActionForm>
          <MoveTableDialog
            id={ids.move}
            bookingId={row.id}
            guestName={row.guestName}
            summary={summary}
            table={row.table}
            moves={moves}
          />
        </div>
      )}
    </li>
  );
}
