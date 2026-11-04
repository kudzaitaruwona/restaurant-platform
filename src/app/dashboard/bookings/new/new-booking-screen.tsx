import Link from "next/link";
import { Button } from "@/components/ui/button";
import { dateLabel } from "@/lib/booking-engine";
import { getStaffBookingForm } from "@/lib/booking-staff";
import { getTenantContext } from "@/lib/tenant";
import { ActionForm } from "../../action-form";
import { Field, inputClassName } from "../../field";

/**
 * Add booking (spec 04) for anyone on the team (S-26). Step one is a plain GET
 * form, which only chooses the party and the date; step two posts the details, so
 * no name or phone ever reaches a URL. Times are the restaurant's.
 */
export async function NewBookingScreen({
  searchParams,
}: {
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const tenant = await getTenantContext();
  const query = (await searchParams) ?? {};
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  const form = await getStaffBookingForm(tenant, { party: first(query.party), date: first(query.date) });

  return (
    <>
      <h1 className="font-heading text-3xl font-semibold tracking-tight">Add booking</h1>
      <p className="text-sm text-muted-foreground">
        Staff can book inside the lead time, for a party over the online limit, on a table of their choice,
        and without a phone number.
      </p>

      <form method="get" action="/dashboard/bookings/new" className="flex flex-wrap items-end gap-3">
        <Field label="Party size">
          <input
            type="number"
            name="party"
            min={1}
            max={999}
            required
            defaultValue={form.party}
            className={inputClassName}
          />
        </Field>
        <Field label="Date">
          <input
            type="date"
            name="date"
            min={form.today}
            max={form.last}
            required
            defaultValue={form.date ?? first(query.date)}
            className={inputClassName}
          />
        </Field>
        <Button type="submit" variant="outline">
          Show times
        </Button>
      </form>

      {form.party && form.date && form.times && (
        <ActionForm
          action="/api/bookings"
          className="flex flex-col gap-4"
          resetOnSuccess
          savedMessage="Booking added."
        >
          <input type="hidden" name="party" value={form.party} />
          <input type="hidden" name="date" value={form.date} />
          <p className="font-medium">
            Party of {form.party}, {dateLabel(form.date)}
          </p>
          {form.times.length === 0 ? (
            <p>The restaurant has no service period on that day, or every time on it has passed.</p>
          ) : (
            <>
              <Field label="Time">
                <select name="time" required className={inputClassName}>
                  {form.times.map(({ time, period, open }) => (
                    <option key={time} value={time}>
                      {time} ({period}){open ? "" : ", no bookable table free"}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Table" hint="Automatic gives the best fit, as online. Walk-in tables can be picked by hand.">
                <select name="tableId" defaultValue="" className={inputClassName}>
                  <option value="">Automatic</option>
                  {form.tables.map((table) => (
                    <option key={table.id} value={table.id}>
                      {table.label} (seats {table.capacity}
                      {table.bookable ? "" : ", walk-ins"})
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Name">
                <input name="name" required maxLength={100} className={inputClassName} />
              </Field>
              <div className="flex gap-2">
                <Field label="Country code">
                  <input name="countryCode" defaultValue="+263" maxLength={8} className={`${inputClassName} w-24`} />
                </Field>
                <Field label="Phone (optional)">
                  <input name="phone" type="tel" maxLength={40} className={inputClassName} />
                </Field>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="whatsapp" />
                The guest agreed to confirmation and reminders on WhatsApp
              </label>
              <Field label="Note (optional)">
                <input name="note" maxLength={200} className={inputClassName} />
              </Field>
              <Button type="submit">Add booking</Button>
            </>
          )}
        </ActionForm>
      )}

      <Link className="underline" href={`/dashboard/bookings${form.date ? `?date=${form.date}` : ""}`}>
        Back to the day
      </Link>
    </>
  );
}
