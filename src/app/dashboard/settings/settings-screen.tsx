import { PageHeader } from "@/components/ui/page-header";
import { currencyMode } from "@/db/schema";
import { getRestaurantSettings, timeZoneOptions } from "@/lib/restaurant-settings";
import { getTenantContext, requireOwner } from "@/lib/tenant";
import { SettingsForm } from "./settings-form";

const currencyLabels: Record<(typeof currencyMode.enumValues)[number], string> = {
  usd_only: "USD only",
  zig_only: "ZiG only",
  usd_primary: "USD, with ZiG beneath",
  zig_primary: "ZiG, with USD beneath",
  both: "USD and ZiG equally",
};

/** Restaurant settings: owner only (S-26). One form, in three groups. */
export async function SettingsScreen() {
  const tenant = await getTenantContext();
  requireOwner(tenant);
  const settings = await getRestaurantSettings(tenant);

  return (
    <div className="flex w-full max-w-4xl flex-col gap-6">
      <PageHeader
        title="Restaurant settings"
        subtitle="What guests see about you, and how prices and times are shown."
      />
      <SettingsForm
        saved={{
          name: settings.name,
          contactPhone: settings.contactPhone ?? "",
          wifiName: settings.wifiName ?? "",
          wifiPassword: settings.wifiPassword ?? "",
          currencyMode: settings.currencyMode,
          timezone: settings.timezone,
        }}
        currencies={currencyMode.enumValues.map((value) => ({
          value,
          label: currencyLabels[value],
        }))}
        zones={timeZoneOptions(settings.timezone)}
      />
    </div>
  );
}

