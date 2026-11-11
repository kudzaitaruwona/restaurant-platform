import { and, asc, eq } from "drizzle-orm";
import {
  CalendarDays,
  ChefHat,
  ChevronRight,
  LayoutGrid,
  type LucideIcon,
  PencilLine,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { inputClassName } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { restaurants, staff } from "@/db/schema";
import { getBookingMetrics } from "@/lib/booking-metrics";
import { getCurrentRate } from "@/lib/exchange-rate";
import { getTenantContext, withTenant } from "@/lib/tenant";
import { cn } from "@/lib/utils";
import { BookingMetricsPanel } from "./booking-metrics";
import { ExchangeRateStatus } from "./exchange-rate-status";
import { initialsOf } from "./shell/nav";

/** The three service screens, the ones a shift opens first. */
const service: { href: string; label: string; detail: string; icon: LucideIcon }[] = [
  { href: "/dashboard/kitchen", label: "Kitchen", detail: "Tickets as they come in", icon: ChefHat },
  { href: "/dashboard/floor", label: "Floor", detail: "Open tables and waiter calls", icon: LayoutGrid },
  { href: "/dashboard/bookings", label: "Bookings", detail: "Today's bookings and walk-ins", icon: CalendarDays },
];

/**
 * The staff home (S-41): where a shift starts. The way into the service
 * screens, and for owners the exchange rate, the booking results and the team,
 * which they can rename here.
 */
export async function Dashboard() {
  const tenant = await getTenantContext();
  const { restaurant, team } = await withTenant(tenant, async (tx) => {
    const [restaurant] = await tx
      .select({ name: restaurants.name })
      .from(restaurants)
      .where(eq(restaurants.id, tenant.restaurantId));
    const team = await tx
      .select({
        id: staff.id,
        displayName: staff.displayName,
        role: staff.role,
      })
      .from(staff)
      .where(
        and(
          eq(staff.restaurantId, tenant.restaurantId),
          eq(staff.active, true),
          eq(staff.kind, "staff"),
        ),
      )
      .orderBy(asc(staff.createdAt), asc(staff.id));
    return { restaurant, team };
  });

  // Owner only (S-26), like the menu it belongs to.
  const [rate, metrics] =
    tenant.role === "owner"
      ? await Promise.all([getCurrentRate(tenant), getBookingMetrics(tenant)])
      : [null, null];

  const owner = tenant.role === "owner";
  const me = tenant.platformAdminId
    ? "platform admin"
    : team.find((member) => member.id === tenant.staffId)?.displayName;

  return (
    <div className="flex w-full max-w-5xl flex-col gap-8">
      <PageHeader title={restaurant.name} subtitle={`Signed in as ${me} (${tenant.role})`} />

      <nav aria-label="Service">
        <ul className="grid gap-3 sm:grid-cols-3">
          {service.map(({ href, label, detail, icon: Icon }) => (
            <li key={href}>
              <Link
                href={href}
                className="group flex min-h-20 items-center gap-4 rounded-card border border-line bg-surface p-4 text-ink no-underline outline-none transition-colors duration-150 hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <span className="grid size-12 shrink-0 place-items-center rounded-control bg-surface-2 group-hover:bg-surface">
                  <Icon aria-hidden className="size-6" strokeWidth={1.75} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-lead font-semibold">{label}</span>
                  <span className="text-caption text-ink-2">{detail}</span>
                </span>
                <ChevronRight aria-hidden className="size-5 shrink-0 text-ink-2" strokeWidth={1.75} />
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {owner && (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <Section title="Exchange rate">
            <Card className="flex flex-col gap-4 p-5">
              <ExchangeRateStatus rate={rate?.usdToZig ?? null} setAt={rate?.setAt ?? null} />
              <Link
                href="/dashboard/menu"
                className={cn(buttonVariants({ variant: "secondary", size: "compact" }), "self-start")}
              >
                Change the exchange rate
              </Link>
            </Card>
          </Section>
          {metrics && (
            <Section title="Booking results" detail="Every booking so far">
              <BookingMetricsPanel metrics={metrics} />
            </Section>
          )}
        </div>
      )}

      <Section
        title="Team"
        detail={`${team.length} ${team.length === 1 ? "person" : "people"}`}
        action={
          owner && (
            <Link
              href="/dashboard/staff"
              className={buttonVariants({ variant: "ghost", size: "compact" })}
            >
              Manage staff
            </Link>
          )
        }
      >
        <Card as="section" aria-label="Team">
          <ul className="divide-y divide-line">
            {team.map((member) => (
              <li key={member.id} className="relative flex flex-col px-4 py-3 sm:px-5">
                <div className={cn("flex min-h-12 items-center gap-3", owner && "pr-14 sm:pr-28")}>
                  <span
                    aria-hidden
                    className="grid size-10 shrink-0 place-items-center rounded-full bg-brand-soft text-caption font-[650] text-ink"
                  >
                    {initialsOf(member.displayName)}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-body font-semibold">
                      {member.displayName}
                      {member.id === tenant.staffId && (
                        <span className="font-normal text-ink-2"> (you)</span>
                      )}
                    </span>
                    <span className="text-caption text-ink-2">
                      {member.role === "owner" ? "Owner" : "Staff"}
                    </span>
                  </span>
                </div>
                {owner && (
                  // Opens without JavaScript; the summary sits in the row above.
                  <details className="group/rename">
                    <summary
                      className={cn(
                        buttonVariants({ variant: "ghost", size: "compact" }),
                        "absolute top-4 right-3 cursor-pointer list-none text-ink-2 group-open/rename:bg-surface-2 group-open/rename:text-ink sm:right-4 [&::-webkit-details-marker]:hidden",
                      )}
                    >
                      <PencilLine aria-hidden strokeWidth={1.75} />
                      <span className="sr-only sm:not-sr-only">Rename</span>
                      <span className="sr-only"> {member.displayName}</span>
                    </summary>
                    {/* A plain post (S-26): the route redirects back here. */}
                    <form
                      method="post"
                      action={`/api/staff/${member.id}`}
                      className="mt-3 flex gap-2 pb-1 sm:pl-[52px]"
                    >
                      <input
                        name="displayName"
                        defaultValue={member.displayName}
                        aria-label={`New name for ${member.displayName}`}
                        required
                        maxLength={200}
                        className={inputClassName}
                      />
                      <Button type="submit" variant="primary" size="staff">
                        Save
                      </Button>
                    </form>
                  </details>
                )}
              </li>
            ))}
          </ul>
        </Card>
      </Section>
    </div>
  );
}

function Section({
  title,
  detail,
  action,
  children,
}: {
  title: string;
  detail?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="flex min-h-10 items-end justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <h2 className="text-title font-semibold text-ink">{title}</h2>
          {detail && <p className="text-caption text-ink-2 tabular-nums">{detail}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
