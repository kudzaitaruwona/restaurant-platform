import { ArrowRight, Circle, CircleCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cardClassName } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { getEnv } from "@/lib/env";
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
import { easeOut, pressable } from "../motion";
import { AdminForm } from "./admin-form";
import { CopyMessage } from "./copy-message";
import { NewRestaurantSheet } from "./new-restaurant-sheet";
import { ownerSignInMessage } from "./sign-in-message";

const currencyModeLabels: Record<CurrencyMode, string> = {
  usd_only: "USD only",
  zig_only: "ZiG only",
  usd_primary: "USD first, ZiG too",
  zig_primary: "ZiG first, USD too",
  both: "USD and ZiG equally",
};

/** Each item's rule in plain words, from platform_onboarding_checklist (0028). */
const onboardingRules: Record<(typeof onboardingItems)[number]["key"], string> = {
  menuEntered: "Done when at least one menu item is live.",
  photos: "Done when a live item has a photo.",
  exchangeRateSet: "Done once any rate is saved. It is set on the Menu page.",
  tablesAdded: "Done when a table is live.",
  qrCodesPrinted: "Tick once the codes are printed and on the tables.",
  bookingHoursSet: "Done when there is a service period.",
  bookingEnabled:
    "Done when online booking is on. It needs a bookable table, a service period and a contact phone.",
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
      <ul className="flex flex-col divide-y divide-line">
        {onboardingItems.map(({ key, label }) => (
          <li key={key} className="flex flex-wrap items-start gap-x-3 gap-y-2 py-3">
            {checklist[key] ? (
              <CircleCheck aria-hidden strokeWidth={1.75} className="mt-px size-5 shrink-0 text-accent" />
            ) : (
              <Circle aria-hidden strokeWidth={1.75} className="mt-px size-5 shrink-0 text-ink-2" />
            )}
            <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
              <span className={cn("text-body font-medium", checklist[key] ? "text-ink" : "text-ink-2")}>
                {label}
                <span className="sr-only">{checklist[key] ? ", done" : ", not done"}</span>
              </span>
              <span className="text-caption text-ink-2">
                {onboardingRules[key]}
                {key === "qrCodesPrinted" && !checklist.tablesAdded && " No tables yet."}
              </span>
            </div>
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
  appUrl,
}: {
  restaurant: Restaurant;
  metrics: Metrics | undefined;
  checklist: Checklist | undefined;
  appUrl: string;
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
          <Button type="submit" size="compact" className={pressable}>
            Enter restaurant
            <ArrowRight aria-hidden strokeWidth={1.75} />
          </Button>
        </form>
      </div>
      <section className="flex flex-col gap-3 border-t border-line p-4 md:px-5">
        <h4 className="text-body font-semibold">Owner</h4>
        {restaurant.hasOwner ? (
          <div className="flex max-w-2xl flex-col gap-2">
            <p className="text-caption text-ink-2">
              Send the owner this on WhatsApp. No invite email goes out.
            </p>
            <CopyMessage
              text={ownerSignInMessage({ restaurantName: restaurant.name, appUrl })}
            />
          </div>
        ) : (
          <>
            <Notice tone="attention">No owner yet. Nobody can sign in to this restaurant.</Notice>
            <AdminForm
              action={`/api/admin/restaurants/${restaurant.id}/owner`}
              submitLabel="Create owner"
              pendingLabel="Creating owner"
              className="grid gap-3 sm:grid-cols-2"
            >
              <Field label="Owner's name">
                <Input name="displayName" required maxLength={200} />
              </Field>
              <Field label="Owner's email" hint="They sign in with this email. No invite is sent; you tell them.">
                <Input name="email" type="email" required />
              </Field>
            </AdminForm>
          </>
        )}
      </section>
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
  const appUrl = getEnv().NEXT_PUBLIC_APP_URL;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Restaurants"
        subtitle={
          restaurants.length === 1
            ? "1 restaurant"
            : `${restaurants.length} restaurants`
        }
        actions={
          <NewRestaurantSheet
            timezone={DEFAULT_TIMEZONE}
            currencyModes={currencyMode.enumValues.map((mode) => ({
              value: mode,
              label: currencyModeLabels[mode],
            }))}
            appUrl={appUrl}
          />
        }
      />

      {restaurants.length === 0 ? (
        <p className={cn(cardClassName, "p-6 text-body text-ink-2")}>
          No restaurants yet. Create the first one with New restaurant.
        </p>
      ) : (
        <ul aria-label="Restaurants" className="flex flex-col gap-4">
          {restaurants.map((restaurant) => (
            <RestaurantItem
              key={restaurant.id}
              restaurant={restaurant}
              metrics={metrics.get(restaurant.id)}
              checklist={checklists.get(restaurant.id)}
              appUrl={appUrl}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
