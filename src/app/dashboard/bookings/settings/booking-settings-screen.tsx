import Link from "next/link";
import { Button } from "@/components/ui/button";
import { listClosures } from "@/lib/booking-closures";
import { localToday } from "@/lib/booking-engine";
import {
  gateMessages,
  getBookingReadiness,
  getBookingSettings,
  listServicePeriods,
  missingForBooking,
  settingFields,
  weekdayNames,
  weekdayOrder,
} from "@/lib/booking-settings";
import { getEnv } from "@/lib/env";
import { bookingPageUrl, qrSvg } from "@/lib/qr-code";
import { getTenantContext, requireOwner } from "@/lib/tenant";
import { ActionForm } from "../../action-form";
import { Field, inputClassName } from "../../field";
import { CopyLinkButton } from "./copy-link-button";

/**
 * Booking settings: owner only (S-26). Switch online booking on or off, set the
 * service periods for each day, and the rules. Spec 04 puts this at
 * /admin/bookings/settings; D-10 (proposed) puts staff pages under /dashboard.
 * Closures (holidays, private events) sit below the periods.
 */
export async function BookingSettingsScreen() {
  const tenant = await getTenantContext();
  requireOwner(tenant);
  const [settings, periods, readiness, closures] = await Promise.all([
    getBookingSettings(tenant),
    listServicePeriods(tenant),
    getBookingReadiness(tenant),
    listClosures(tenant),
  ]);
  const today = localToday(new Date(), readiness.timezone);
  const missing = missingForBooking({
    periods: periods.length,
    bookableTables: readiness.bookableTables,
    contactPhone: readiness.contactPhone,
  });
  const bookingLink = bookingPageUrl(getEnv().NEXT_PUBLIC_APP_URL, readiness.slug);
  const bookingQr = await qrSvg(bookingLink);

  return (
    <div className="flex flex-col gap-8">
      <div>
        <Link href="/dashboard" className="text-sm text-muted-foreground underline">
          Back to dashboard
        </Link>
        <h1 className="font-heading text-3xl font-semibold tracking-tight">Booking settings</h1>
      </div>

      <section className="flex flex-col gap-3" aria-labelledby="online-booking">
        <h2 id="online-booking" className="text-xl font-semibold">
          Online booking is {settings.enabled ? "on" : "off"}
        </h2>
        {missing.length > 0 && (
          <div className="text-sm text-muted-foreground">
            <p>Before you can turn it on:</p>
            <ul className="list-disc pl-5">
              {missing.map((item) => (
                <li key={item}>{gateMessages[item]}</li>
              ))}
            </ul>
            {missing.includes("table") && (
              <Link href="/dashboard/tables" className="underline">
                Go to tables
              </Link>
            )}
          </div>
        )}
        <ActionForm
          action="/api/bookings/settings/enabled"
          className="flex flex-col gap-2"
        >
          <input type="hidden" name="enabled" value={settings.enabled ? "false" : "true"} />
          <Button type="submit" className="self-start" variant={settings.enabled ? "outline" : "default"}>
            {settings.enabled ? "Turn online booking off" : "Turn online booking on"}
          </Button>
        </ActionForm>
        <p className="text-sm text-muted-foreground">
          Online booking switches itself off if you delete the last service period, archive the
          last table that can be booked, make that table walk-ins only, or clear the contact phone.
          Put back what&apos;s missing to turn it on again.
        </p>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="booking-link">
        <h2 id="booking-link" className="text-xl font-semibold">
          Share your booking page
        </h2>
        <p className="text-sm text-muted-foreground">
          Put the link or the code on Instagram, your WhatsApp status or your Google profile.
          {!settings.enabled && " Guests who open the link will see that online booking is off until you turn it on."}
        </p>
        <input
          readOnly
          aria-label="Booking link"
          value={bookingLink}
          className={inputClassName}
        />
        <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
          <CopyLinkButton text={bookingLink} />
          <div
            role="img"
            aria-label="QR code for the booking link"
            className="w-40 shrink-0 [&>svg]:h-auto [&>svg]:w-full"
            dangerouslySetInnerHTML={{ __html: bookingQr }}
          />
        </div>
      </section>

      <section className="flex flex-col gap-4" aria-labelledby="service-periods">
        <div>
          <h2 id="service-periods" className="text-xl font-semibold">
            Service periods
          </h2>
          <p className="text-sm text-muted-foreground">
            When guests can book, in {readiness.timezone} time. A day can have several, like lunch
            and dinner. They can&apos;t overlap or run past midnight. The last booking time is the
            latest a guest can start; closing is when service ends.
          </p>
        </div>
        {weekdayOrder.map((weekday) => {
          const today = periods.filter((period) => period.weekday === weekday);
          return (
            <div key={weekday} className="flex flex-col gap-2">
              <h3 className="font-medium">{weekdayNames[weekday]}</h3>
              {today.length === 0 && (
                <p className="text-sm text-muted-foreground">No service periods.</p>
              )}
              {today.map((period) => (
                <div key={period.id} className="flex flex-col gap-1">
                  <ActionForm
                    action={`/api/bookings/periods/${period.id}`}
                    savedMessage="Saved."
                    className="flex flex-wrap items-end gap-3"
                  >
                    <PeriodFields period={period} />
                    <Button type="submit" size="sm">
                      Save
                    </Button>
                  </ActionForm>
                  <ActionForm
                    action={`/api/bookings/periods/${period.id}/delete`}
                    confirmation={
                      `Delete ${period.name} on ${weekdayNames[weekday]}?` +
                      (settings.enabled && periods.length === 1
                        ? " It's the last service period, so online booking will switch off."
                        : "")
                    }
                    savedMessage="Deleted. If it was the last one, online booking is switched off."
                  >
                    <Button type="submit" size="sm" variant="outline">
                      Delete
                    </Button>
                  </ActionForm>
                </div>
              ))}
              <ActionForm
                action="/api/bookings/periods"
                resetOnSuccess
                savedMessage="Added."
                className="flex flex-wrap items-end gap-3"
              >
                <input type="hidden" name="weekday" value={weekday} />
                <PeriodFields />
                <Button type="submit" size="sm" variant="outline">
                  Add period
                </Button>
              </ActionForm>
            </div>
          );
        })}
      </section>

      <section className="flex flex-col gap-4" aria-labelledby="closures">
        <div>
          <h2 id="closures" className="text-xl font-semibold">
            Closures
          </h2>
          <p className="text-sm text-muted-foreground">
            Holidays and private events, in {readiness.timezone} time. Leave the times empty to
            close whole days, from the start date to the end date; give both times to close part
            of a day. Guests can&apos;t book any time whose sitting would run into a closure. A
            closure can&apos;t be saved over a confirmed booking: you&apos;ll see the bookings
            first, and move or cancel each one on the bookings page.
          </p>
        </div>
        {closures.length === 0 && <p className="text-sm text-muted-foreground">No upcoming closures.</p>}
        {closures.map((closure) => (
          <ActionForm
            key={closure.id}
            action={`/api/bookings/closures/${closure.id}/delete`}
            confirmation={`Remove the closure on ${closure.label}? Guests will be able to book those times again.`}
            savedMessage="Removed."
            className="flex flex-wrap items-center gap-3"
          >
            <p>
              <span className="font-medium">{closure.label}</span>
              {closure.reason && <span className="text-muted-foreground"> · {closure.reason}</span>}
            </p>
            <Button type="submit" size="sm" variant="outline">
              Remove
            </Button>
          </ActionForm>
        ))}
        <ActionForm
          action="/api/bookings/closures"
          resetOnSuccess
          savedMessage="Closure saved."
          className="flex flex-wrap items-end gap-3"
        >
          <Field label="From date">
            <input name="startDate" type="date" min={today} required className={inputClassName} />
          </Field>
          <Field label="To date (optional)">
            <input name="endDate" type="date" min={today} className={inputClassName} />
          </Field>
          <Field label="From time (optional)">
            <input name="startTime" type="time" className={inputClassName} />
          </Field>
          <Field label="To time (optional)">
            <input name="endTime" type="time" className={inputClassName} />
          </Field>
          <Field label="Reason (optional)">
            <input name="reason" maxLength={200} placeholder="Independence Day" className={inputClassName} />
          </Field>
          <Button type="submit" size="sm" variant="outline">
            Add closure
          </Button>
        </ActionForm>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="booking-rules">
        <h2 id="booking-rules" className="text-xl font-semibold">
          Booking rules
        </h2>
        <ActionForm
          action="/api/bookings/settings"
          savedMessage="Saved. Changes apply to bookings made from now on."
          className="flex flex-col gap-4"
        >
          {settingFields.map(({ key, label, min, max }) => (
            <Field key={key} label={label}>
              <input
                name={key}
                type="number"
                inputMode="numeric"
                min={min}
                max={max}
                defaultValue={settings[key]}
                required
                className={inputClassName}
              />
            </Field>
          ))}
          <Button type="submit" className="self-start">
            Save rules
          </Button>
        </ActionForm>
      </section>
    </div>
  );
}

function PeriodFields({
  period,
}: {
  period?: { name: string; opensAt: string; lastBookingAt: string; closesAt: string };
}) {
  return (
    <>
      <Field label="Name">
        <input
          name="name"
          defaultValue={period?.name}
          placeholder="Lunch"
          required
          maxLength={50}
          className={inputClassName}
        />
      </Field>
      <Field label="Opens">
        <input name="opensAt" type="time" defaultValue={period?.opensAt} required className={inputClassName} />
      </Field>
      <Field label="Last booking">
        <input
          name="lastBookingAt"
          type="time"
          defaultValue={period?.lastBookingAt}
          required
          className={inputClassName}
        />
      </Field>
      <Field label="Closes">
        <input name="closesAt" type="time" defaultValue={period?.closesAt} required className={inputClassName} />
      </Field>
    </>
  );
}
