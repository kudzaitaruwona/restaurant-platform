import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { inputClassName } from "@/app/dashboard/field";
import { getBookingPage, type TimeChoice } from "@/lib/bookings";
import { resolvePublicToken } from "@/lib/tenant/public";
import { DetailsForm } from "./details-form";

export const metadata: Metadata = { title: "Book a table" };

// Nothing here can be prerendered or cached: a stale list would offer tables that
// have gone. The route's shell is empty, but Next.js still sends its 200 first, so
// an unknown slug gets the not-found page with noindex, not a 404 status (spec 04).
export const instant = false;

const first = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

const byPeriod = (times: readonly TimeChoice[]) =>
  Map.groupBy(times, (time) => time.period);

/**
 * The guest's booking page (spec 04). Party, date and time are plain links and a
 * GET form, so each step is a page the server worked out at that moment. Only the
 * details step needs a script, to keep what was typed through a refusal.
 */
export default async function Page({ params, searchParams }: PageProps<"/r/[slug]/book">) {
  // First: this is what keeps every prerender Next.js tries of this path away from
  // the database, whose driver it refuses for reading random bytes.
  await connection();
  const { slug } = await params;
  const tenant = await resolvePublicToken("slug", slug);
  if (!tenant) notFound();

  const query = await searchParams;
  const page = await getBookingPage(tenant, {
    party: first(query.party),
    date: first(query.date),
  });
  const { restaurantName, contactPhone, party, date, times } = page;
  const chosen = times?.find((time) => time.time === first(query.time));

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
      <h1 className="font-heading text-2xl font-semibold tracking-tight">{restaurantName}</h1>

      {!page.enabled ? (
        <div className="flex flex-col gap-1">
          <p>Online booking isn&apos;t available right now.</p>
          {contactPhone && (
            <p className="text-muted-foreground">
              To book, call <a className="underline" href={`tel:${contactPhone}`}>{contactPhone}</a>.
            </p>
          )}
        </div>
      ) : (
        <>
          <form method="get" className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm font-medium">
              Party size
              <select name="party" defaultValue={party ?? 2} className={inputClassName}>
                {Array.from({ length: page.maxParty }, (_, index) => index + 1).map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium">
              Date
              <select
                name="date"
                defaultValue={date?.date ?? page.dates.find((day) => day.open)?.date}
                className={inputClassName}
              >
                {page.dates.map((day) => (
                  <option key={day.date} value={day.date} disabled={!day.open}>
                    {day.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
            >
              Show times
            </button>
          </form>

          {times && date && (
            <section className="flex flex-col gap-4" aria-label="Available times">
              {times.length === 0 && (
                <p className="text-muted-foreground">
                  No tables for {party} on {date.label}. Try another date.
                </p>
              )}
              {[...byPeriod(times)].map(([period, slots]) => (
                <div key={period} className="flex flex-col gap-2">
                  <h2 className="text-sm font-medium">{period}</h2>
                  <ul className="flex flex-wrap gap-2">
                    {slots.map(({ time }) => (
                      <li key={time}>
                        <a
                          href={`?party=${party}&date=${date.date}&time=${time}`}
                          aria-current={time === chosen?.time ? "true" : undefined}
                          className="block rounded-md border px-3 py-1.5 text-sm aria-[current]:bg-primary aria-[current]:text-primary-foreground"
                        >
                          {time}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          )}

          {chosen && party && date && (
            <DetailsForm
              action={`/api/r/${encodeURIComponent(slug)}/book`}
              party={party}
              date={date.date}
              dateLabel={date.label}
              time={chosen.time}
            />
          )}
        </>
      )}
    </main>
  );
}
