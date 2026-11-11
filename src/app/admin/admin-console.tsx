import { ArrowRight, Circle, CircleCheck, Store } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cardClassName } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/utils";
import { currencyMode } from "@/db/schema";
import {
  type CurrencyMode,
  DEFAULT_TIMEZONE,
  getPlatformAdminContext,
  listBookingMetrics,
  listRestaurants,
  onboardingChecklists,
  onboardingItems,
} from "@/lib/tenant/platform-admin";
import { BookingMetricsPanel } from "../dashboard/booking-metrics";
import { easeOut } from "../motion";
import { AdminForm } from "./admin-form";

const currencyModeLabels: Record<CurrencyMode, string> = {
  usd_only: "USD only",
  zig_only: "ZiG only",
  usd_primary: "USD first, ZiG too",
  zig_primary: "ZiG first, USD too",
  both: "USD and ZiG equally",
};

type Restaurant = Awaited<ReturnType<typeof listRestaurants>>[number];
type Checklist = NonNullable<
  ReturnType<Awaited<ReturnType<typeof onboardingChecklists>>["get"]>
>;
type Metrics = NonNullable<
  ReturnType<Awaited<ReturnType<typeof listBookingMetrics>>["get"]>
>;

/** The manual item: when it was ticked is shown in the restaurant's own timezone. */
function QrCodesPrintedForm({
  restaurantId,
  printed,
  printedAt,
  timezone,
}: {
  restaurantId: string;
  printed: boolean;
  printedAt: Date | null;
  timezone: string;
}) {
  return (
    <span className="ml-auto flex items-center gap-3">
      {printedAt && (
        <span className="text-caption text-ink-2 tabular-nums">
          {new Intl.DateTimeFormat("en-GB", {
            dateStyle: "medium",
            timeZone: timezone,
          }).format(printedAt)}
        </span>
      )}
      <AdminForm
        action={`/api/admin/restaurants/${restaurantId}/qr-codes-printed`}
        submitLabel={printed ? "Untick" : "Tick as printed"}
        submitVariant={printed ? "ghost" : "secondary"}
        inline
      >
        <input type="hidden" name="printed" value={String(!printed)} />
      </AdminForm>
    </span>
  );
}

function Onboarding({
  restaurant,
  checklist,
}: {
  restaurant: Restaurant;
  checklist: Checklist;
}) {
  const done = onboardingItems.filter(({ key }) => checklist[key]).length;
  return (
    <section className="flex flex-col gap-3 border-t border-line p-4 md:px-5">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-caption font-medium text-ink-2">Onboarding</h4>
        <p className="text-caption text-ink-2 tabular-nums">
          {done} of {onboardingItems.length} done
        </p>
      </div>
      <div
        aria-hidden
        className="h-1.5 overflow-hidden rounded-full bg-surface-2"
      >
        {/* scaleX, not width: it eases along on the GPU when a tick refreshes it. */}
        <div
          className={cn(
            "h-full origin-left rounded-full bg-accent transition-transform duration-300 motion-reduce:transition-none",
            easeOut,
          )}
          style={{ transform: `scaleX(${done / onboardingItems.length})` }}
        />
      </div>
      <ul className="grid gap-x-6 sm:grid-cols-2">
        {onboardingItems.map(({ key, label }) => (
          <li
            key={key}
            className={cn(
              "flex min-h-10 items-center gap-2.5 py-1 text-body",
              // The one item the admin ticks by hand: last, with room for its button.
              key === "qrCodesPrinted" &&
                "order-last mt-1 border-t border-line pt-2 sm:col-span-2",
            )}
          >
            {checklist[key] ? (
              <CircleCheck aria-hidden strokeWidth={1.75} className="size-5 shrink-0 text-accent" />
            ) : (
              <Circle aria-hidden strokeWidth={1.75} className="size-5 shrink-0 text-ink-2" />
            )}
            <span className={checklist[key] ? "text-ink" : "text-ink-2"}>{label}</span>
            <span className="sr-only">{checklist[key] ? "done" : "not done"}</span>
            {key === "qrCodesPrinted" && (
              <QrCodesPrintedForm
                restaurantId={restaurant.id}
                printed={checklist.qrCodesPrinted}
                printedAt={checklist.qrCodesPrintedAt}
                timezone={restaurant.timezone}
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * One restaurant. The order matters to the screen's tests and to reading it:
 * who it is and the way in, its numbers, then what's left to set up.
 */
function RestaurantItem({
  restaurant,
  metrics,
  checklist,
}: {
  restaurant: Restaurant;
  metrics: Metrics | undefined;
  checklist: Checklist | undefined;
}) {
  return (
    <li className={cn(cardClassName, "overflow-hidden")}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 p-4 md:px-5">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lead font-semibold">{restaurant.name}</h3>
            {!restaurant.hasOwner && (
              <span className="inline-flex h-6 items-center rounded-full bg-attention-soft px-2.5 text-caption font-medium text-attention-ink">
                No owner yet
              </span>
            )}
          </div>
          <p className="text-caption text-ink-2">
            /r/{restaurant.slug} · {restaurant.timezone} ·{" "}
            {currencyModeLabels[restaurant.currencyMode]}
          </p>
        </div>
        <form
          method="post"
          action={`/api/admin/restaurants/${restaurant.id}/enter`}
        >
          <Button type="submit" variant="secondary" size="compact">
            Enter restaurant
            <ArrowRight aria-hidden strokeWidth={1.75} />
          </Button>
        </form>
      </div>
      {!restaurant.hasOwner && (
        <section className="flex flex-col gap-3 border-t border-line p-4 md:px-5">
          <h4 className="text-body font-semibold">First owner</h4>
          <AdminForm
            action={`/api/admin/restaurants/${restaurant.id}/owner`}
            submitLabel="Create owner"
            pendingLabel="Creating owner"
            className="grid gap-3 sm:grid-cols-2"
          >
            <Field label="Owner's email">
              <Input name="email" type="email" required />
            </Field>
            <Field label="Owner's name">
              <Input name="displayName" required maxLength={200} />
            </Field>
          </AdminForm>
        </section>
      )}
      {metrics && (
        <section className="flex flex-col gap-3 border-t border-line p-4 md:px-5">
          <h4 className="text-caption font-medium text-ink-2">Bookings</h4>
          <BookingMetricsPanel metrics={metrics} />
        </section>
      )}
      {checklist && <Onboarding restaurant={restaurant} checklist={checklist} />}
    </li>
  );
}

/** Creates restaurants and their first owners, and enters them (spec 01, S-26). */
export async function AdminConsole() {
  const admin = await getPlatformAdminContext();
  const [restaurants, metrics, checklists] = await Promise.all([
    listRestaurants(admin),
    listBookingMetrics(admin),
    onboardingChecklists(admin),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Platform admin"
        subtitle={
          restaurants.length === 1
            ? "1 restaurant"
            : `${restaurants.length} restaurants`
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <section aria-labelledby="restaurants" className="flex flex-col gap-3">
          <h2 id="restaurants" className="text-title font-semibold">
            Restaurants
          </h2>
          {restaurants.length === 0 ? (
            <p className={cn(cardClassName, "p-6 text-body text-ink-2")}>
              No restaurants yet. Create the first one.
            </p>
          ) : (
            <ul className="flex flex-col gap-4">
              {restaurants.map((restaurant) => (
                <RestaurantItem
                  key={restaurant.id}
                  restaurant={restaurant}
                  metrics={metrics.get(restaurant.id)}
                  checklist={checklists.get(restaurant.id)}
                />
              ))}
            </ul>
          )}
        </section>

        <section
          aria-labelledby="new-restaurant"
          className={cn(cardClassName, "flex flex-col gap-4 p-4 md:p-5 lg:sticky lg:top-6")}
        >
          <h2 id="new-restaurant" className="flex items-center gap-2 text-title font-semibold">
            <Store aria-hidden strokeWidth={1.75} className="size-5 text-ink-2" />
            New restaurant
          </h2>
          <AdminForm
            action="/api/admin/restaurants"
            submitLabel="Create restaurant"
            pendingLabel="Creating restaurant"
          >
            <Field label="Name">
              <Input name="name" required maxLength={200} />
            </Field>
            <Field label="Slug" hint="Its public address, /r/your-slug">
              <Input name="slug" required maxLength={63} />
            </Field>
            <Field label="Timezone">
              <Input name="timezone" required defaultValue={DEFAULT_TIMEZONE} />
            </Field>
            <Field label="Currency mode">
              <Select name="currencyMode" required>
                {currencyMode.enumValues.map((mode) => (
                  <option key={mode} value={mode}>
                    {currencyModeLabels[mode]}
                  </option>
                ))}
              </Select>
            </Field>
          </AdminForm>
        </section>
      </div>
    </div>
  );
}
