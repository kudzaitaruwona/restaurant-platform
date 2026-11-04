import type { BookingMetrics } from "@/lib/booking-metrics";

const percent = (share: number) => `${Math.round(share * 100)}%`;

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-2xl font-semibold">{value}</dd>
      <dd className="text-sm text-muted-foreground">{detail}</dd>
    </div>
  );
}

/**
 * The success metrics (spec 04), for the owner's dashboard and the admin console
 * alike. It only shows what booking_success_metrics counted, so the two can't
 * differ. No times are shown: "while staff weren't answering" was judged on the
 * restaurant's own clock in Postgres.
 */
export function BookingMetricsPanel({ metrics }: { metrics: BookingMetrics }) {
  const { onlineShare, noShowRate } = metrics;
  return (
    <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <Metric
        label="Booked online"
        value={onlineShare === null ? "–" : percent(onlineShare)}
        detail={
          onlineShare === null
            ? "No bookings yet"
            : `${metrics.online} online, ${metrics.staff} added by staff`
        }
      />
      <Metric
        label="Booked while staff weren't answering"
        value={String(metrics.outsideHours)}
        detail="Online bookings made outside service hours"
      />
      <Metric
        label="No-show rate"
        value={noShowRate === null ? "–" : percent(noShowRate)}
        detail={
          noShowRate === null
            ? "No finished bookings yet"
            : `${metrics.noShows} of ${metrics.attended} finished bookings`
        }
      />
    </dl>
  );
}
