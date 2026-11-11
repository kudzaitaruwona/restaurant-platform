import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { cardClassName } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { Stepper } from "@/components/ui/stepper";
import { dateLabel } from "@/lib/booking-engine";
import { getStaffBookingForm } from "@/lib/booking-staff";
import { getTenantContext } from "@/lib/tenant";
import { cn } from "@/lib/utils";
import { ActionForm } from "../../action-form";

const card = cn(cardClassName, "p-4 md:p-6");

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
  const back = `/dashboard/bookings${form.date ? `?date=${form.date}` : ""}`;

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <Link href={back} className={cn(buttonVariants({ variant: "ghost", size: "compact" }), "-ml-3 self-start text-ink-2")}>
        <ChevronLeft aria-hidden />
        Back to the day
      </Link>
      <PageHeader
        title="Add booking"
        subtitle="Staff can book inside the lead time, for a party over the online limit, on a table of their choice, and without a phone number."
      />

      <form
        method="get"
        action="/dashboard/bookings/new"
        aria-label="Party and date"
        className={cn(card, "flex flex-wrap items-end gap-4")}
      >
        <div className="flex flex-col gap-1.5">
          <span id="new-party" className="text-caption font-medium text-ink-2">
            Party size
          </span>
          <Stepper
            name="party"
            min={1}
            max={999}
            required
            defaultValue={form.party}
            aria-labelledby="new-party"
            decreaseLabel="One fewer guest"
            increaseLabel="One more guest"
          />
        </div>
        <Field label="Date" className="min-w-40 flex-1 sm:flex-none">
          <Input
            type="date"
            name="date"
            min={form.today}
            max={form.last}
            required
            defaultValue={form.date ?? first(query.date)}
            className="tabular-nums sm:w-48"
          />
        </Field>
        <Button type="submit" variant="secondary" size="staff" className="w-full sm:w-auto">
          Show times
        </Button>
      </form>

      {form.party && form.date && form.times && (
        <section aria-labelledby="booking-details" className={card}>
          <ActionForm
            action="/api/bookings"
            className="flex flex-col gap-4"
            resetOnSuccess
            savedMessage="Booking added."
          >
            <input type="hidden" name="party" value={form.party} />
            <input type="hidden" name="date" value={form.date} />
            <h2 id="booking-details" className="text-title font-semibold tabular-nums">
              Party of {form.party}, {dateLabel(form.date)}
            </h2>
            {form.times.length === 0 ? (
              <Notice>The restaurant has no service period on that day, or every time on it has passed.</Notice>
            ) : (
              <>
                <div className="grid items-start gap-4 sm:grid-cols-2">
                  <Field label="Time">
                    <Select name="time" required className="tabular-nums">
                      {form.times.map(({ time, period, open }) => (
                        <option key={time} value={time}>
                          {time} ({period}){open ? "" : ", no bookable table free"}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field
                    label="Table"
                    hint="Automatic gives the best fit, as online. Walk-in tables can be picked by hand."
                  >
                    <Select name="tableId" defaultValue="">
                      <option value="">Automatic</option>
                      {form.tables.map((table) => (
                        <option key={table.id} value={table.id}>
                          {table.label} (seats {table.capacity}
                          {table.bookable ? "" : ", walk-ins"})
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <Field label="Name">
                  <Input name="name" required maxLength={100} />
                </Field>
                <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3">
                  <Field label="Country code">
                    <Input name="countryCode" defaultValue="+263" maxLength={8} className="tabular-nums" />
                  </Field>
                  <Field label="Phone (optional)">
                    <Input name="phone" type="tel" maxLength={40} className="tabular-nums" />
                  </Field>
                </div>
                <label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-control border border-line px-3 py-2 text-body has-checked:border-ink">
                  <input type="checkbox" name="whatsapp" className="size-5 shrink-0 accent-brand" />
                  The guest agreed to confirmation and reminders on WhatsApp
                </label>
                <Field label="Note (optional)">
                  <Input name="note" maxLength={200} />
                </Field>
                <Button type="submit" size="staff" className="w-full sm:w-auto sm:self-start">
                  Add booking
                </Button>
              </>
            )}
          </ActionForm>
        </section>
      )}
    </div>
  );
}
