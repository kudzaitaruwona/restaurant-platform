import Link from "next/link";
import { Button } from "@/components/ui/button";
import { currencyMode } from "@/db/schema";
import { getRestaurantSettings, timeZoneOptions } from "@/lib/restaurant-settings";
import { getTenantContext, requireOwner } from "@/lib/tenant";
import { ActionForm } from "../action-form";
import { Field, inputClassName } from "../field";

const currencyLabels: Record<(typeof currencyMode.enumValues)[number], string> = {
  usd_only: "USD only",
  zig_only: "ZiG only",
  usd_primary: "USD, with ZiG beneath",
  zig_primary: "ZiG, with USD beneath",
  both: "USD and ZiG equally",
};

/** Restaurant settings: owner only (S-26). */
export async function SettingsScreen() {
  const tenant = await getTenantContext();
  requireOwner(tenant);
  const settings = await getRestaurantSettings(tenant);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/dashboard" className="text-sm text-muted-foreground underline">
          Back to dashboard
        </Link>
        <h1 className="font-heading text-3xl font-semibold tracking-tight">
          Restaurant settings
        </h1>
      </div>
      <ActionForm
        action="/api/restaurant"
        savedMessage="Settings saved. If you cleared the contact phone, online booking has switched off."
        className="flex flex-col gap-4"
      >
        <Field label="Restaurant name">
          <input
            name="name"
            defaultValue={settings.name}
            required
            maxLength={200}
            className={inputClassName}
          />
        </Field>
        <Field
          label="Contact phone"
          hint="International format, like +263771234567. Guests see it for large parties and booking changes."
        >
          <input
            name="contactPhone"
            type="tel"
            defaultValue={settings.contactPhone ?? ""}
            className={inputClassName}
          />
        </Field>
        <Field label="Wi-Fi name">
          <input
            name="wifiName"
            defaultValue={settings.wifiName ?? ""}
            maxLength={200}
            className={inputClassName}
          />
        </Field>
        <Field label="Wi-Fi password" hint="Printed on every table QR card, so customers will see it. Use a guest network, not the one your staff or tills use. You can leave it off the sheet when printing.">
          <input
            name="wifiPassword"
            type="password"
            autoComplete="off"
            defaultValue={settings.wifiPassword ?? ""}
            maxLength={200}
            className={inputClassName}
          />
        </Field>
        <Field label="Currency display">
          <select
            name="currencyMode"
            defaultValue={settings.currencyMode}
            className={inputClassName}
          >
            {currencyMode.enumValues.map((mode) => (
              <option key={mode} value={mode}>
                {currencyLabels[mode]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Timezone" hint="Every time on the site is shown in this zone.">
          <select
            name="timezone"
            defaultValue={settings.timezone}
            className={inputClassName}
          >
            {timeZoneOptions(settings.timezone).map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </Field>
        <Button type="submit" className="self-start">
          Save settings
        </Button>
      </ActionForm>
    </div>
  );
}
