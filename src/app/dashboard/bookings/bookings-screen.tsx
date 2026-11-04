import Link from "next/link";
import { Button } from "@/components/ui/button";
import { getDayView } from "@/lib/booking-day";
import { contactLinks, type DayRow } from "@/lib/booking-day-view";
import { getTenantContext } from "@/lib/tenant";
import { ActionForm } from "../action-form";

const statusLabels = {
  confirmed: "Confirmed",
  seated: "Seated",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No-show",
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * The day view (spec 04) for anyone on the team (S-26): a day's bookings by
 * service period, with the status actions. Every time on it is the restaurant's.
 * Phones are in the markup only because the viewer is that restaurant's staff.
 */
export async function BookingsScreen({
  searchParams,
}: {
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const tenant = await getTenantContext();
  const query = (await searchParams) ?? {};
  const day = await getDayView(tenant, query.date);

  return (
    <>
      <h1 className="font-heading text-3xl font-semibold tracking-tight">Bookings</h1>

      <div className="flex flex-col gap-2">
        <p className="text-lg font-medium">
          {day.dateLabel}
          {day.isToday && <span className="text-muted-foreground"> (today)</span>}
        </p>
        {day.refused && (
          <p role="status" className="text-sm text-muted-foreground">
            That date wasn&apos;t usable, so this is today.
          </p>
        )}
        <nav aria-label="Choose a day" className="flex flex-wrap items-end gap-3 text-sm">
          <Link className="underline" href={`/dashboard/bookings?date=${day.previous}`}>
            Previous day
          </Link>
          {!day.isToday && (
            <Link className="underline" href="/dashboard/bookings">
              Today
            </Link>
          )}
          <Link className="underline" href={`/dashboard/bookings?date=${day.next}`}>
            Next day
          </Link>
          <form method="get" action="/dashboard/bookings" className="flex items-end gap-2">
            <label className="flex flex-col gap-1 font-medium">
              Go to date
              <input
                type="date"
                name="date"
                defaultValue={day.date}
                required
                className="rounded-md border bg-background px-2 py-1.5"
              />
            </label>
            <Button type="submit" size="sm" variant="outline">
              Show
            </Button>
          </form>
        </nav>
      </div>

      {day.groups.length === 0 && <p>No bookings on this day.</p>}
      {day.groups.map((group) => (
        <section key={group.name} className="flex flex-col gap-1">
          <h2 className="font-heading text-xl font-semibold">{group.name}</h2>
          <p className="text-sm text-muted-foreground">
            {plural(group.bookingCount, "booking")}, {plural(group.covers, "cover")}
            {" "}(cancelled and no-shows not counted)
          </p>
          {group.rows.length === 0 ? (
            <p className="py-2 text-sm">No bookings.</p>
          ) : (
            <ul className="flex flex-col divide-y">
              {group.rows.map((row) => (
                <BookingRow key={row.id} row={row} />
              ))}
            </ul>
          )}
        </section>
      ))}
    </>
  );
}

function BookingRow({ row }: { row: DayRow }) {
  const links = contactLinks(row.phone);
  const closed = row.status === "cancelled" || row.status === "no_show";
  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex items-baseline gap-3">
        <span className="font-medium tabular-nums">{row.time}</span>
        <span className="min-w-0 flex-1 break-words">
          <span className={closed ? "text-muted-foreground line-through" : undefined}>
            {row.guestName}
          </span>
          <span className="block text-sm text-muted-foreground">
            Party of {row.partySize}, table {row.table}
          </span>
          {row.note && <span className="block text-sm break-words">Note: {row.note}</span>}
        </span>
        <span className="text-sm">
          {statusLabels[row.status]}
          {row.late && <strong className="ml-2 text-destructive">Late</strong>}
        </span>
      </div>
      <div className="flex flex-wrap items-start gap-2">
        {links && (
          <>
            <a href={links.tel} className="rounded-md border px-3 py-1.5 text-sm">
              Call
            </a>
            <a
              href={links.whatsapp}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md border px-3 py-1.5 text-sm"
            >
              WhatsApp
            </a>
          </>
        )}
        {row.status === "confirmed" && (
          <>
            <ActionForm action={`/api/bookings/${row.id}/seat`}>
              <Button type="submit" size="sm">
                Seat
              </Button>
            </ActionForm>
            <ActionForm
              action={`/api/bookings/${row.id}/no-show`}
              confirmation={`Mark ${row.guestName} as a no-show? Their table is freed.`}
            >
              <Button type="submit" size="sm" variant="outline">
                No-show
              </Button>
            </ActionForm>
            <ActionForm
              action={`/api/bookings/${row.id}/cancel`}
              confirmation={`Cancel the booking for ${row.guestName}? Their table is freed.`}
            >
              <Button type="submit" size="sm" variant="outline">
                Cancel
              </Button>
            </ActionForm>
          </>
        )}
        {row.status === "seated" && (
          <ActionForm action={`/api/bookings/${row.id}/finish`}>
            <Button type="submit" size="sm">
              Finish
            </Button>
          </ActionForm>
        )}
      </div>
    </li>
  );
}
