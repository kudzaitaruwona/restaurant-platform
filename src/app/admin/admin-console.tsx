import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
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
import { AdminForm } from "./admin-form";

const currencyModeLabels: Record<CurrencyMode, string> = {
  usd_only: "USD only",
  zig_only: "ZiG only",
  usd_primary: "USD first, ZiG too",
  zig_primary: "ZiG first, USD too",
  both: "USD and ZiG equally",
};

const fieldClass = "min-w-0 rounded-md border px-2 py-1 text-sm";

function Field({
  label,
  ...input
}: { label: string } & ComponentProps<"input">) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <input className={fieldClass} {...input} />
    </label>
  );
}

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
    <>
      {printedAt && (
        <span className="text-muted-foreground">
          {new Intl.DateTimeFormat("en-GB", {
            dateStyle: "medium",
            timeZone: timezone,
          }).format(printedAt)}
        </span>
      )}
      <AdminForm
        action={`/api/admin/restaurants/${restaurantId}/qr-codes-printed`}
        submitLabel={printed ? "Untick" : "Tick as printed"}
      >
        <input type="hidden" name="printed" value={String(!printed)} />
      </AdminForm>
    </>
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
    <div className="flex flex-col gap-8">
      <h1 className="font-heading text-3xl font-semibold tracking-tight">
        Platform admin
      </h1>

      <section className="flex flex-col gap-3">
        <h2 className="font-heading text-xl font-semibold">New restaurant</h2>
        <AdminForm
          action="/api/admin/restaurants"
          submitLabel="Create restaurant"
        >
          <Field label="Name" name="name" required maxLength={200} />
          <Field
            label="Slug (its public address, /r/your-slug)"
            name="slug"
            required
            maxLength={63}
          />
          <Field
            label="Timezone"
            name="timezone"
            required
            defaultValue={DEFAULT_TIMEZONE}
          />
          <label className="flex flex-col gap-1 text-sm">
            Currency mode
            <select name="currencyMode" required className={fieldClass}>
              {currencyMode.enumValues.map((mode) => (
                <option key={mode} value={mode}>
                  {currencyModeLabels[mode]}
                </option>
              ))}
            </select>
          </label>
        </AdminForm>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-heading text-xl font-semibold">Restaurants</h2>
        <ul className="flex flex-col gap-6">
          {restaurants.map((restaurant) => {
            const checklist = checklists.get(restaurant.id);
            return (
              <li key={restaurant.id} className="flex flex-col gap-2">
                <div>
                  <p className="font-medium">{restaurant.name}</p>
                  <p className="text-sm text-muted-foreground">
                    /r/{restaurant.slug} · {restaurant.timezone} ·{" "}
                    {currencyModeLabels[restaurant.currencyMode]}
                  </p>
                </div>
                {metrics.has(restaurant.id) && (
                  <BookingMetricsPanel metrics={metrics.get(restaurant.id)!} />
                )}
                <form
                  method="post"
                  action={`/api/admin/restaurants/${restaurant.id}/enter`}
                >
                  <Button type="submit" variant="outline" size="sm">
                    Enter restaurant
                  </Button>
                </form>
                {checklist && (
                  <div className="flex flex-col gap-1">
                    <h3 className="text-sm font-medium">Onboarding</h3>
                    <ul className="flex flex-col gap-1 text-sm">
                      {onboardingItems.map(({ key, label }) => (
                        <li key={key} className="flex items-center gap-2">
                          <span aria-hidden>{checklist[key] ? "✓" : "○"}</span>
                          <span>{label}</span>
                          <span className="sr-only">
                            {checklist[key] ? "done" : "not done"}
                          </span>
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
                  </div>
                )}
                {!restaurant.hasOwner && (
                  <AdminForm
                    action={`/api/admin/restaurants/${restaurant.id}/owner`}
                    submitLabel="Create owner"
                  >
                    <Field
                      label="Owner's email"
                      name="email"
                      type="email"
                      required
                    />
                    <Field
                      label="Owner's name"
                      name="displayName"
                      required
                      maxLength={200}
                    />
                  </AdminForm>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
