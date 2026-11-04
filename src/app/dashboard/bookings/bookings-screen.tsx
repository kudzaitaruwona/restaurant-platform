import { listTodaysBookings } from "@/lib/bookings";
import { getTenantContext } from "@/lib/tenant";

const statusLabels = {
  confirmed: "Confirmed",
  seated: "Seated",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No-show",
};

/** Today's bookings for anyone on the team (S-26). #35 grows this into the day view. */
export async function BookingsScreen() {
  const tenant = await getTenantContext();
  const { dateLabel, bookings } = await listTodaysBookings(tenant);

  return (
    <>
      <h1 className="font-heading text-3xl font-semibold tracking-tight">Bookings</h1>
      <p className="text-muted-foreground">{dateLabel}</p>
      {bookings.length === 0 ? (
        <p>No bookings today.</p>
      ) : (
        <ul className="flex flex-col divide-y">
          {bookings.map((booking) => (
            <li key={booking.id} className="flex items-baseline gap-3 py-2">
              <span className="font-medium tabular-nums">{booking.time}</span>
              <span className="min-w-0 flex-1 break-words">
                {booking.guestName}
                <span className="block text-sm text-muted-foreground">
                  Party of {booking.partySize}, table {booking.table}
                </span>
              </span>
              <span className="text-sm">{statusLabels[booking.status]}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
