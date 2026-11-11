import type { BookingMetrics } from "@/lib/booking-metrics";
import { cn } from "@/lib/utils";

const percent = (share: number) => `${Math.round(share * 100)}%`;

/** Before there is anything to count; never a dash (S-41 copy rules) or a false 0%. */
const NOT_YET = "Not yet";

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  const empty = value === NOT_YET;
  return (
    <div className="flex min-w-0 flex-col gap-1 p-4 sm:p-5">
      <dt className="text-caption font-medium text-ink-2 sm:min-h-[2lh]">{label}</dt>
      <dd
        className={cn(
          "font-semibold tracking-[-0.01em] tabular-nums",
          empty ? "text-lead text-ink-2" : "text-display text-ink",
        )}
      >
        {value}
      </dd>
      <dd className="text-caption text-ink-2">{detail}</dd>
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
    <dl className="grid grid-cols-1 divide-y divide-line rounded-card border border-line bg-surface sm:grid-cols-3 sm:divide-x sm:divide-y-0">
      <Metric
        label="Booked online"
        value={onlineShare === null ? NOT_YET : percent(onlineShare)}
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
        value={noShowRate === null ? NOT_YET : percent(noShowRate)}
        detail={
          noShowRate === null
            ? "No finished bookings yet"
            : `${metrics.noShows} of ${metrics.attended} finished bookings`
        }
      />
    </dl>
  );
}
