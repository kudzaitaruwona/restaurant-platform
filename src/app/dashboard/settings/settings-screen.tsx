import { ChevronRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { currencyMode } from "@/db/schema";
import { getRestaurantSettings, timeZoneOptions } from "@/lib/restaurant-settings";
import { getTenantContext, requireOwner } from "@/lib/tenant";
import { ActionForm } from "../action-form";

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
      <ActionForm
        action="/api/restaurant"
        savedMessage="Settings saved. If you cleared the contact phone, online booking has switched off."
        className="flex flex-col gap-6"
      >
        <Group title="Restaurant" description="Your name and phone, as guests see them.">
          <Field label="Restaurant name">
            <Input name="name" defaultValue={settings.name} required maxLength={200} />
          </Field>
          <Field
            label="Contact phone"
            hint="International format, like +263771234567. Guests see it for large parties and booking changes."
          >
            <Input name="contactPhone" type="tel" defaultValue={settings.contactPhone ?? ""} />
          </Field>
        </Group>

        <Group title="Guest Wi-Fi" description="Printed on the table QR cards.">
          <Field label="Wi-Fi name">
            <Input name="wifiName" defaultValue={settings.wifiName ?? ""} maxLength={200} />
          </Field>
          <Field
            label="Wi-Fi password"
            hint="Printed on every table QR card, so customers will see it. Use a guest network, not the one your staff or tills use. You can leave it off the sheet when printing."
          >
            <Input
              name="wifiPassword"
              type="password"
              autoComplete="off"
              defaultValue={settings.wifiPassword ?? ""}
              maxLength={200}
            />
          </Field>
        </Group>

        <Group title="Prices and time" description="For the menu, bookings and every screen.">
          <Field label="Currency display">
            <Select name="currencyMode" defaultValue={settings.currencyMode}>
              {currencyMode.enumValues.map((mode) => (
                <option key={mode} value={mode}>
                  {currencyLabels[mode]}
                </option>
              ))}
            </Select>
          </Field>
          <Link
            href="/dashboard/menu"
            className="-mx-2 flex min-h-12 items-center gap-3 rounded-control px-2 text-body text-ink no-underline outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-medium">Exchange rate</span>
              <span className="text-caption text-ink-2">Set and changed on the Menu page</span>
            </span>
            <ChevronRight aria-hidden className="size-5 shrink-0 text-ink-2" strokeWidth={1.75} />
          </Link>
          <Field label="Timezone" hint="Every time on the site is shown in this zone.">
            <Select name="timezone" defaultValue={settings.timezone}>
              {timeZoneOptions(settings.timezone).map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </Select>
          </Field>
        </Group>

        <div className="flex justify-end border-t border-line pt-5">
          <Button type="submit" size="staff" className="w-full sm:w-auto">
            Save settings
          </Button>
        </div>
      </ActionForm>
    </div>
  );
}

/** A titled group: the title beside the card on wide screens, above it on narrow ones. */
function Group({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] md:gap-8">
      <div className="flex flex-col gap-1 md:pt-5">
        <h2 className="text-lead font-semibold text-ink">{title}</h2>
        <p className="text-caption text-ink-2">{description}</p>
      </div>
      <Card className="flex flex-col gap-5 p-4 sm:p-5">{children}</Card>
    </section>
  );
}
