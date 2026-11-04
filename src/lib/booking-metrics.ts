import "server-only";
import { sql } from "drizzle-orm";
import { type TenantContext, withTenant } from "@/lib/tenant/scope";

/**
 * The booking success metrics (spec 04 › Success metrics). The counting is one
 * Postgres function, booking_success_metrics (migration 0029), which this file
 * calls for an owner, and the admin console reaches the same function for every
 * restaurant through the platform-admin seam, so the two can't disagree. What
 * counts, and the restaurant's clock, are decided there.
 */

type Tenant = Pick<TenantContext, "restaurantId">;

/** A row of booking_success_metrics, as Postgres names the columns. */
export type MetricCounts = {
  online: number;
  staff: number;
  outside_hours: number;
  no_shows: number;
  attended: number;
};

export type BookingMetrics = {
  /** Bookings guests made themselves. */
  online: number;
  /** Bookings staff added. */
  staff: number;
  /** Online share of both, 0 to 1; null before there are any. */
  onlineShare: number | null;
  /** Online bookings made while no service period was open. */
  outsideHours: number;
  noShows: number;
  /** Seated, completed and no-show bookings: the ones with a known outcome. */
  attended: number;
  /** No-shows among them, 0 to 1; null before there are any. */
  noShowRate: number | null;
};

const ratio = (part: number, whole: number) => (whole === 0 ? null : part / whole);

/** The one place counts become the numbers shown, for the owner and the admin. */
export function metricsFrom(counts: MetricCounts): BookingMetrics {
  return {
    online: counts.online,
    staff: counts.staff,
    onlineShare: ratio(counts.online, counts.online + counts.staff),
    outsideHours: counts.outside_hours,
    noShows: counts.no_shows,
    attended: counts.attended,
    noShowRate: ratio(counts.no_shows, counts.attended),
  };
}

/** The restaurant's own numbers. The restaurant comes from the context. */
export function getBookingMetrics(tenant: Tenant) {
  return withTenant(tenant, async (tx) => {
    const { rows } = await tx.execute<MetricCounts>(
      sql`select * from booking_success_metrics(${tenant.restaurantId})`,
    );
    return metricsFrom(rows[0]);
  });
}
