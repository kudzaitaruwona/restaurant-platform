import { ArrowRight, Circle, CircleCheck } from "lucide-react";
import { CsvImportDialog } from "@/components/csv-import-dialog";
import { Button } from "@/components/ui/button";
import { cardClassName } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { getEnv } from "@/lib/env";
import { cn } from "@/lib/utils";
import { currencyMode } from "@/db/schema";
import { DEFAULT_CURRENCY_MODE, timezoneChoices } from "@/lib/new-restaurant";
import {
  type CurrencyMode,
  DEFAULT_TIMEZONE,
  getPlatformAdminContext,
  listBookingMetrics,
  listOwners,
  listRestaurants,
  onboardingChecklists,
  onboardingItems,
  type OwnerOnCard,
} from "@/lib/tenant/platform-admin";
import { inviteStatus } from "@/lib/invite-status";
import { RESTAURANTS_MAX_ROWS } from "@/lib/restaurant-import";
import { BookingMetricsPanel } from "../dashboard/booking-metrics";
import { InviteStatusLabel } from "../dashboard/staff/invite-status";
import { easeOut, pressable } from "../motion";
import { AdminForm } from "./admin-form";
import { CopyMessage } from "./copy-message";
import { NewRestaurantSheet } from "./new-restaurant-sheet";
import { RestaurantList, type RestaurantListItem } from "./restaurant-list";
import { ownerSignInMessage } from "./sign-in-message";

const currencyModeLabels: Record<CurrencyMode, string> = {
  usd_only: "USD only",
  zig_only: "ZiG only",
  usd_primary: "USD first, ZiG too",
  zig_primary: "ZiG first, USD too",
  both: "USD and ZiG equally",
};

/** Each item's rule in plain words, as derived by the platform_onboarding_checklist function, migration 0028. */
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

/**
 * Where each item is dealt with, in the restaurant's own screens. The admin has
 * to be inside the restaurant to see them, so the link enters it first.
 */
const onboardingPages: Record<
  (typeof onboardingItems)[number]["key"],
  { href: string; label: string }
> = {
  menuEntered: { href: "/dashboard/menu", label: "Open Menu" },
  photos: { href: "/dashboard/menu", label: "Open Menu" },
  exchangeRateSet: { href: "/dashboard/menu", label: "Open Menu" },
  tablesAdded: { href: "/dashboard/tables", label: "Open Tables" },
  qrCodesPrinted: { href: "/dashboard/tables", label: "Open Tables" },
  bookingHoursSet: { href: "/dashboard/bookings/settings", label: "Open Booking settings" },
  bookingEnabled: { href: "/dashboard/bookings/settings", label: "Open Booking settings" },
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
              <form
                method="post"
                action={`/api/admin/restaurants/${restaurant.id}/enter`}
                className="mt-1"
              >
                <input type="hidden" name="next" value={onboardingPages[key].href} />
                <button
                  type="submit"
                  className="inline-flex min-h-8 items-center gap-1 rounded-control text-caption font-medium text-accent underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {onboardingPages[key].label}
                  <ArrowRight aria-hidden strokeWidth={1.75} className="size-3.5" />
                </button>
              </form>
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

/** Each active owner: who, Invited or Joined (S-42), and the invite again until they join. */
function Owners({ restaurant, owners }: { restaurant: Restaurant; owners: OwnerOnCard[] }) {
  return (
    <ul className="flex flex-col divide-y divide-line">
      {owners.map((owner) => {
        const status = inviteStatus(owner, restaurant.timezone);
        return (
          <li key={owner.id} className="flex flex-wrap items-start gap-x-4 gap-y-2 py-3 first:pt-0">
            <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
              <span className="text-body font-medium">{owner.displayName}</span>
              <span className="text-caption [overflow-wrap:anywhere] text-ink-2">{owner.email}</span>
              <InviteStatusLabel status={status} className="mt-1" />
            </div>
            {status.kind !== "joined" && (
              <AdminForm
                action={`/api/admin/restaurants/${restaurant.id}/invite`}
                // Someone never invited is sent one, not sent one again.
                submitLabel={status.kind === "not_invited" ? "Send invite" : "Send invite again"}
                pendingLabel="Sending"
                submitVariant="secondary"
                inline
              >
                <input type="hidden" name="staffId" value={owner.id} />
              </AdminForm>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** What the WhatsApp message is for, said to match where the owner's invite stands (S-42). */
function whatsAppIntro(owners: OwnerOnCard[], timezone: string) {
  const kinds = owners.map((owner) => inviteStatus(owner, timezone).kind);
  if (kinds.every((kind) => kind === "joined")) return undefined;
  if (kinds.includes("not_invited")) {
    return "They haven't been invited yet. Send the invite above, or send them this on WhatsApp.";
  }
  if (kinds.includes("not_sent")) {
    return "The invite email didn't go. Send it again above, or send them this on WhatsApp.";
  }
  return "They get an invite by email. You can also send them this on WhatsApp.";
}

/**
 * One restaurant, as the list shows it: a summary that is always there (who it
 * is, how far set up, the way in), and details that open (owner, numbers, then
 * what's left to set up, in that order, which the screen's tests rely on).
 */
function restaurantItem({
  restaurant,
  owners,
  metrics,
  checklist,
  appUrl,
}: {
  restaurant: Restaurant;
  owners: OwnerOnCard[];
  metrics: Metrics | undefined;
  checklist: Checklist | undefined;
  appUrl: string;
}): RestaurantListItem {
  const intro = whatsAppIntro(owners, restaurant.timezone);
  const done = checklist ? onboardingItems.filter(({ key }) => checklist[key]).length : undefined;
  return {
    id: restaurant.id,
    name: restaurant.name,
    searchText: [restaurant.name, restaurant.slug, ...owners.flatMap((o) => [o.displayName, o.email])]
      .join(" ")
      .toLowerCase(),
    summary: (
      <>
        <div className="flex min-w-0 flex-1 basis-60 flex-col gap-1">
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
            {done !== undefined && checklist && ` · ${done} of ${onboardingItems.length} set up`}
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
      </>
    ),
    details: (
      <>
        <section className="flex flex-col gap-3 border-t border-line p-4 md:px-5">
          <h4 className="text-body font-semibold">Owner</h4>
          {restaurant.hasOwner ? (
            <>
              <Owners restaurant={restaurant} owners={owners} />
              {intro && (
                <div className="flex max-w-2xl flex-col gap-2">
                  <p className="text-caption text-ink-2">{intro}</p>
                  <CopyMessage
                    text={ownerSignInMessage({ restaurantName: restaurant.name, appUrl })}
                  />
                </div>
              )}
            </>
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
                <Field label="Owner's email" hint="We email them an invite. They sign in with this address.">
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
      </>
    ),
  };
}

/** Creates restaurants and their first owners, and enters them (spec 01, S-26). */
export async function AdminConsole() {
  const admin = await getPlatformAdminContext();
  const [restaurants, owners, metrics, checklists] = await Promise.all([
    listRestaurants(admin),
    listOwners(admin),
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
          <>
            <CsvImportDialog
              kind="restaurants"
              action="/api/admin/restaurants/import"
              title="Import restaurants"
              noun={{ one: "restaurant", other: "restaurants" }}
              triggerSize="compact"
              maxRows={RESTAURANTS_MAX_ROWS}
              intro={
                <p>
                  Columns: restaurant_name, slug (the public address; blank makes one from the name),
                  timezone (blank is {DEFAULT_TIMEZONE}), currency_mode (usd_only, zig_only,
                  usd_primary, zig_primary or both; blank is {DEFAULT_CURRENCY_MODE}), owner_email and
                  owner_name. Each restaurant is created with its owner, and the owner is invited by
                  email.
                </p>
              }
            />
            <NewRestaurantSheet
              timezone={DEFAULT_TIMEZONE}
              timezones={timezoneChoices()}
              currencyMode={DEFAULT_CURRENCY_MODE}
              currencyModes={currencyMode.enumValues.map((mode) => ({
                value: mode,
                label: currencyModeLabels[mode],
              }))}
              appUrl={appUrl}
            />
          </>
        }
      />

      {restaurants.length === 0 ? (
        <p className={cn(cardClassName, "p-6 text-body text-ink-2")}>
          No restaurants yet. Create the first one with New restaurant.
        </p>
      ) : (
        <RestaurantList
          items={restaurants.map((restaurant) =>
            restaurantItem({
              restaurant,
              owners: owners.get(restaurant.id) ?? [],
              metrics: metrics.get(restaurant.id),
              checklist: checklists.get(restaurant.id),
              appUrl,
            }),
          )}
        />
      )}
    </div>
  );
}
