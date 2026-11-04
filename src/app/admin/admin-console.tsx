import type { ComponentProps } from "react";
import { currencyMode } from "@/db/schema";
import {
  type CurrencyMode,
  DEFAULT_TIMEZONE,
  getPlatformAdminContext,
  listRestaurants,
} from "@/lib/tenant/platform-admin";
import { AdminForm } from "./admin-form";

const currencyModeLabels: Record<CurrencyMode, string> = {
  usd_only: "USD only",
  zig_only: "ZiG only",
  usd_primary: "USD first, ZiG too",
  zig_primary: "ZiG first, USD too",
  both: "USD and ZiG equally",
};

const fieldClass = "min-w-0 rounded-md border px-2 py-1 text-sm";

function Field({ label, ...input }: { label: string } & ComponentProps<"input">) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <input className={fieldClass} {...input} />
    </label>
  );
}

/** Creates restaurants and their first owners (spec 01, S-26). */
export async function AdminConsole() {
  const admin = await getPlatformAdminContext();
  const restaurants = await listRestaurants(admin);

  return (
    <div className="flex flex-col gap-8">
      <h1 className="font-heading text-3xl font-semibold tracking-tight">
        Platform admin
      </h1>

      <section className="flex flex-col gap-3">
        <h2 className="font-heading text-xl font-semibold">New restaurant</h2>
        <AdminForm action="/api/admin/restaurants" submitLabel="Create restaurant">
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
          {restaurants.map((restaurant) => (
            <li key={restaurant.id} className="flex flex-col gap-2">
              <div>
                <p className="font-medium">{restaurant.name}</p>
                <p className="text-sm text-muted-foreground">
                  /r/{restaurant.slug} · {restaurant.timezone} ·{" "}
                  {currencyModeLabels[restaurant.currencyMode]}
                </p>
              </div>
              {!restaurant.hasOwner && (
                <AdminForm
                  action={`/api/admin/restaurants/${restaurant.id}/owner`}
                  submitLabel="Create owner"
                >
                  <Field label="Owner's email" name="email" type="email" required />
                  <Field
                    label="Owner's name"
                    name="displayName"
                    required
                    maxLength={200}
                  />
                </AdminForm>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
