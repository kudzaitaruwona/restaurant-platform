import Link from "next/link";
import { Button } from "@/components/ui/button";
import { cardClassName } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
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
import { cn } from "@/lib/utils";
import { ActionForm } from "../../action-form";
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
    <div className="flex max-w-4xl flex-col gap-6">
      <PageHeader title="Booking settings" />

      <section className={card} aria-labelledby="online-booking">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="online-booking" className="flex items-center gap-3 text-title font-semibold">
            Online booking is {settings.enabled ? "on" : "off"}
            <span
              aria-hidden
              className={cn(
                "size-2.5 rounded-full",
                settings.enabled ? "bg-accent" : "border border-ink-2",
              )}
            />
          </h2>
          <ActionForm action="/api/bookings/settings/enabled" className="flex flex-col gap-2">
            <input type="hidden" name="enabled" value={settings.enabled ? "false" : "true"} />
            <Button type="submit" size="staff" variant={settings.enabled ? "secondary" : "primary"}>
              {settings.enabled ? "Turn online booking off" : "Turn online booking on"}
            </Button>
          </ActionForm>
        </div>
        {missing.length > 0 && (
          <Notice tone="attention" title="Before you can turn it on:" className="mt-4">
            <ul className="list-disc pl-5">
              {missing.map((item) => (
                <li key={item}>{gateMessages[item]}</li>
              ))}
            </ul>
            {missing.includes("table") && (
              <Link href="/dashboard/tables" className="mt-1 inline-block font-medium underline underline-offset-4">
                Go to tables
              </Link>
            )}
          </Notice>
        )}
        <p className="mt-3 text-caption text-ink-2">
          Online booking switches itself off if you delete the last service period, archive the
          last table that can be booked, make that table walk-ins only, or clear the contact phone.
          Put back what&apos;s missing to turn it on again.
        </p>
      </section>

      <section className={card} aria-labelledby="booking-link">
        <h2 id="booking-link" className="text-title font-semibold">
          Share your booking page
        </h2>
        <p className="mt-1 text-body text-ink-2">
          Put the link or the code on Instagram, your WhatsApp status or your Google profile.
          {!settings.enabled && " Guests who open the link will see that online booking is off until you turn it on."}
        </p>
        <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-start">
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <Input readOnly aria-label="Booking link" value={bookingLink} />
            <CopyLinkButton text={bookingLink} />
          </div>
          <div
            role="img"
            aria-label="QR code for the booking link"
            className="w-40 shrink-0 overflow-hidden rounded-control border border-line [&>svg]:block [&>svg]:h-auto [&>svg]:w-full"
            dangerouslySetInnerHTML={{ __html: bookingQr }}
          />
        </div>
      </section>

      <section className={card} aria-labelledby="service-periods">
        <h2 id="service-periods" className="text-title font-semibold">
          Service periods
        </h2>
        <p className="mt-1 text-body text-ink-2">
          When guests can book, in {readiness.timezone} time. A day can have several, like lunch
          and dinner. They can&apos;t overlap or run past midnight. The last booking time is the
          latest a guest can start; closing is when service ends.
        </p>
        <div className="mt-2 divide-y divide-line">
          {weekdayOrder.map((weekday) => {
            const today = periods.filter((period) => period.weekday === weekday);
            return (
              <div key={weekday} className="flex flex-col gap-3 py-4 last:pb-0">
                <h3 className="text-lead font-semibold">{weekdayNames[weekday]}</h3>
                {today.length === 0 && <p className="text-caption text-ink-2">No service periods.</p>}
                {today.map((period) => (
                  <div key={period.id} className="flex flex-col gap-2 md:flex-row md:items-end md:gap-3">
                    <div className="min-w-0 flex-1">
                      <ActionForm
                        action={`/api/bookings/periods/${period.id}`}
                        savedMessage="Saved."
                        className={periodGrid}
                      >
                        <PeriodFields period={period} />
                        <Button type="submit" variant="secondary" size="staff">
                          Save
                        </Button>
                      </ActionForm>
                    </div>
                    <div className="md:w-24">
                      <ActionForm
                        action={`/api/bookings/periods/${period.id}/delete`}
                        confirmation={{
                          title: `Delete ${period.name} on ${weekdayNames[weekday]}?`,
                          description:
                            settings.enabled && periods.length === 1
                              ? "It's the last service period, so online booking will switch off."
                              : undefined,
                          confirmLabel: "Delete period",
                          cancelLabel: "Keep it",
                        }}
                        savedMessage="Deleted. If it was the last one, online booking is switched off."
                      >
                        <Button type="submit" variant="danger-ghost" size="staff">
                          Delete
                        </Button>
                      </ActionForm>
                    </div>
                  </div>
                ))}
                {/* Lined up with the periods above, whose Delete sits in the last 6rem. */}
                <div className="md:pr-[6.75rem]">
                  <ActionForm
                    action="/api/bookings/periods"
                    resetOnSuccess
                    savedMessage="Added."
                    className={periodGrid}
                  >
                    <input type="hidden" name="weekday" value={weekday} />
                    <PeriodFields />
                    <Button type="submit" variant="secondary" size="staff">
                      Add period
                    </Button>
                  </ActionForm>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className={card} aria-labelledby="closures">
        <h2 id="closures" className="text-title font-semibold">
          Closures
        </h2>
        <p className="mt-1 text-body text-ink-2">
          Holidays and private events, in {readiness.timezone} time. Leave the times empty to
          close whole days, from the start date to the end date; give both times to close part
          of a day. Guests can&apos;t book any time whose sitting would run into a closure. A
          closure can&apos;t be saved over a confirmed booking: you&apos;ll see the bookings
          first, and cancel each one on the bookings page. To keep a guest, add them again at another time.
        </p>
        <div className="mt-3 divide-y divide-line border-y border-line">
          {closures.length === 0 && <p className="py-3 text-body text-ink-2">No upcoming closures.</p>}
          {closures.map((closure) => (
            <ActionForm
              key={closure.id}
              action={`/api/bookings/closures/${closure.id}/delete`}
              confirmation={{
                title: `Remove the closure on ${closure.label}?`,
                description: "Guests will be able to book those times again.",
                confirmLabel: "Remove closure",
                cancelLabel: "Keep it",
              }}
              savedMessage="Removed."
              className="flex min-h-14 flex-wrap items-center justify-between gap-3 py-2"
            >
              <p className="min-w-0">
                <span className="font-semibold tabular-nums">{closure.label}</span>
                {closure.reason && <span className="text-ink-2"> · {closure.reason}</span>}
              </p>
              <Button type="submit" variant="danger-ghost" size="staff">
                Remove
              </Button>
            </ActionForm>
          ))}
        </div>
        <h3 className="mt-5 text-lead font-semibold">Add a closure</h3>
        <ActionForm
          action="/api/bookings/closures"
          resetOnSuccess
          savedMessage="Closure saved."
          className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 [&>[role=alert]]:col-span-full [&>[role=status]]:col-span-full"
        >
          <Field label="From date">
            <Input name="startDate" type="date" min={today} required className="tabular-nums" />
          </Field>
          <Field label="To date (optional)">
            <Input name="endDate" type="date" min={today} className="tabular-nums" />
          </Field>
          <Field label="From time (optional)">
            <Input name="startTime" type="time" className="tabular-nums" />
          </Field>
          <Field label="To time (optional)">
            <Input name="endTime" type="time" className="tabular-nums" />
          </Field>
          <Field label="Reason (optional)" className="sm:col-span-2 lg:col-span-3">
            <Input name="reason" maxLength={200} placeholder="Independence Day" />
          </Field>
          <Button type="submit" variant="secondary" size="staff" className="self-end">
            Add closure
          </Button>
        </ActionForm>
      </section>

      <section className={card} aria-labelledby="booking-rules">
        <h2 id="booking-rules" className="text-title font-semibold">
          Booking rules
        </h2>
        <ActionForm
          action="/api/bookings/settings"
          savedMessage="Saved. Changes apply to bookings made from now on."
          className="mt-4 grid gap-4 sm:grid-cols-2 [&>[role=alert]]:col-span-full [&>[role=status]]:col-span-full"
        >
          {settingFields.map(({ key, label, min, max }) => (
            <Field key={key} label={label}>
              <Input
                name={key}
                type="number"
                inputMode="numeric"
                min={min}
                max={max}
                defaultValue={settings[key]}
                required
              />
            </Field>
          ))}
          <Button type="submit" size="staff" className="col-span-full justify-self-start">
            Save rules
          </Button>
        </ActionForm>
      </section>
    </div>
  );
}

const card = cn(cardClassName, "p-4 md:p-6");

/** Name, opens, last booking, closes and the button, in one row from 768px. */
const periodGrid =
  "grid grid-cols-3 items-end gap-3 md:grid-cols-[minmax(0,1.3fr)_repeat(3,minmax(0,1fr))_7rem] [&>[role=alert]]:col-span-full [&>[role=status]]:col-span-full [&>button]:col-span-3 md:[&>button]:col-span-1 [&>label:first-of-type]:col-span-3 md:[&>label:first-of-type]:col-span-1";

function PeriodFields({
  period,
}: {
  period?: { name: string; opensAt: string; lastBookingAt: string; closesAt: string };
}) {
  return (
    <>
      <Field label="Name">
        <Input
          name="name"
          defaultValue={period?.name}
          placeholder="Lunch"
          required
          maxLength={50}
        />
      </Field>
      <Field label="Opens">
        <Input name="opensAt" type="time" defaultValue={period?.opensAt} required className="tabular-nums" />
      </Field>
      <Field label="Last booking">
        <Input
          name="lastBookingAt"
          type="time"
          defaultValue={period?.lastBookingAt}
          required
          className="tabular-nums"
        />
      </Field>
      <Field label="Closes">
        <Input name="closesAt" type="time" defaultValue={period?.closesAt} required className="tabular-nums" />
      </Field>
    </>
  );
}
