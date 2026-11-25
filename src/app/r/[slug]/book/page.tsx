import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Calendar, Clock, MessageCircle, Phone, Users } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { ChoiceChip } from "@/components/ui/chip";
import { getBookingPage, largePartyMessage } from "@/lib/bookings";
import { displayPhone } from "@/lib/display-phone";
import { resolvePublicToken } from "@/lib/tenant/public";
import { cn } from "@/lib/utils";
import { BookingSteps, ChoiceRow, Choices, TimeGrid } from "./booking-steps";
import { DetailsForm } from "./details-form";

export const metadata: Metadata = { title: "Book a table" };

// Nothing here can be prerendered or cached: a stale list would offer tables that
// have gone. The route's shell is empty, but Next.js still sends its 200 first, so
// an unknown slug gets the not-found page with noindex, not a 404 status (spec 04).
export const instant = false;

const first = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

/** A row of choices: scrolls sideways on a phone, wraps on a desktop. */
const choiceRow =
  "-mx-4 flex gap-2 overflow-x-auto px-4 py-0.5 [scrollbar-width:none] lg:mx-0 lg:flex-wrap lg:overflow-visible lg:px-0";

/** A question's heading: party size, date, available times. */
const questionLabel =
  "mb-3 flex items-center gap-2 p-0 text-body font-semibold text-ink [&_svg]:size-[18px] [&_svg]:shrink-0 [&_svg]:text-ink-2";

const partyChip = "min-w-11 shrink-0 [&>span]:px-3 [&>span]:tabular-nums";

/**
 * The results belong to the party and date they were loaded for (data-loaded). While
 * either is no longer the one chosen, they are hidden. In CSS, so it needs no script
 * and can't disagree with the radios, whoever set them (Back restores them too).
 */
const clearedWhenChanged = "group-has-[[data-loaded]:not(:checked)]/steps:hidden";

/**
 * A date as a chip: weekday, day and month, or "No times" when nothing on it can
 * be booked. A radio in the GET form, like the party size.
 */
function DateChip({
  value,
  label,
  today,
  open,
  checked,
  loaded,
}: {
  value: string;
  label: string;
  today: boolean;
  open: boolean;
  checked: boolean;
  /** The times below are this date's. */
  loaded: boolean;
}) {
  // dateLabel's "Thu 12 Nov", in its three parts.
  const [weekday, day, month] = label.split(" ");
  return (
    <label className="relative inline-flex shrink-0">
      <input
        type="radio"
        name="date"
        value={value}
        disabled={!open}
        defaultChecked={checked}
        data-loaded={loaded ? "" : undefined}
        aria-label={open ? label : `${label}, no times`}
        className="peer sr-only"
      />
      <span
        aria-hidden
        className={cn(
          "flex h-[68px] w-[60px] cursor-pointer flex-col items-center justify-center rounded-card border border-line bg-surface leading-tight text-ink transition-colors duration-150 ease-out hover:bg-surface-2",
          "peer-checked:border-brand peer-checked:bg-brand peer-checked:text-brand-ink peer-checked:[&_small]:text-brand-ink",
          "peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background",
          "peer-disabled:cursor-not-allowed peer-disabled:border-dashed peer-disabled:bg-transparent peer-disabled:text-ink-2",
        )}
      >
        <small className="text-caption font-medium text-ink-2">{today ? "Today" : weekday}</small>
        <b className={cn("text-title tabular-nums", open ? "font-semibold" : "font-medium")}>{day}</b>
        {open ? (
          <small className="text-caption font-medium text-ink-2">{month}</small>
        ) : (
          <em className="text-caption not-italic">No times</em>
        )}
      </span>
    </label>
  );
}

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
  // Any size past the options is the last one.
  const chosenParty = Math.min(page.requestedParty ?? 2, page.maxParty + 1);
  const loadedParty = times || page.largeParty ? chosenParty : undefined;
  const chosenDate = date?.date ?? page.dates.find((day) => day.open)?.date;
  const details = page.enabled && chosen && party && date ? { chosen, party, date } : undefined;

  const action = `/api/r/${encodeURIComponent(slug)}/book`;

  return (
    <main
      className={cn(
        "mx-auto w-full max-w-[480px] flex-1 px-4 pt-5 pb-8 lg:px-6 lg:py-10",
        // Beside the details from 1024px up, so the times stay in view while typing.
        details ? "lg:max-w-[960px]" : "lg:max-w-[560px]",
      )}
    >
      <BookingSteps
        action={action}
        time={details?.chosen.time}
        className={cn(
          "group/steps",
          details && "lg:grid lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start lg:gap-12",
        )}
      >
        <div className="flex min-w-0 flex-col gap-7">
          <header>
            <h1 className="text-heading font-semibold tracking-[-0.015em] text-ink">{restaurantName}</h1>
            <p className="mt-0.5 text-body text-ink-2">Book a table</p>
          </header>

          {!page.enabled ? (
            <div className="flex flex-col gap-1 rounded-card bg-surface-2 p-4">
              <p>Online booking isn&apos;t available right now.</p>
              {contactPhone && (
                <p className="text-body text-ink-2">
                  To book, call{" "}
                  <a
                    className="text-ink tabular-nums underline underline-offset-2"
                    href={`tel:${contactPhone}`}
                  >
                    {displayPhone(contactPhone)}
                  </a>
                  .
                </p>
              )}
            </div>
          ) : (
            <Choices>
              <form method="get" className="flex flex-col gap-7">
                <fieldset className="m-0 min-w-0 border-0 p-0">
                  <legend className={questionLabel}>
                    <Users aria-hidden />
                    Party size
                  </legend>
                  <ChoiceRow className={choiceRow}>
                    {Array.from({ length: page.maxParty }, (_, index) => index + 1).map((size) => (
                      <ChoiceChip
                        key={size}
                        name="party"
                        value={size}
                        defaultChecked={size === chosenParty}
                        data-loaded={size === loadedParty ? "" : undefined}
                        className={partyChip}
                      >
                        {size}
                      </ChoiceChip>
                    ))}
                    {/* The final option (spec 04): bigger than any online party, so it goes
                        straight to the contact message. */}
                    <ChoiceChip
                      name="party"
                      value={page.maxParty + 1}
                      defaultChecked={page.maxParty + 1 === chosenParty}
                      data-loaded={page.maxParty + 1 === loadedParty ? "" : undefined}
                      className={partyChip}
                    >
                      {page.maxParty + 1}+
                    </ChoiceChip>
                  </ChoiceRow>
                </fieldset>

                <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
                  <legend className={questionLabel}>
                    <Calendar aria-hidden />
                    Date
                  </legend>
                  <ChoiceRow className={choiceRow}>
                    {page.dates.map((day, index) => (
                      <DateChip
                        key={day.date}
                        value={day.date}
                        label={day.label}
                        // The list starts at the restaurant's today (spec 04).
                        today={index === 0}
                        open={day.open}
                        checked={day.date === chosenDate}
                        loaded={times !== undefined && day.date === date?.date}
                      />
                    ))}
                  </ChoiceRow>
                  <button
                    type="submit"
                    className={cn(buttonVariants({ variant: "secondary" }), "self-start")}
                  >
                    Show times
                  </button>
                  {loadedParty !== undefined && (
                    <p
                      role="status"
                      className="hidden text-body text-ink-2 group-has-[[data-loaded]:not(:checked)]/steps:block"
                    >
                      Show times to see what&apos;s free for your new choice.
                    </p>
                  )}
                </fieldset>
              </form>

              {page.largeParty && (
                <section
                  className={cn("flex flex-col gap-3 rounded-card bg-surface-2 p-4", clearedWhenChanged)}
                  aria-label="Large groups"
                >
                  <p className="flex items-start gap-3 font-semibold">
                    <Users aria-hidden className="mt-0.5 size-5 shrink-0 text-ink-2" />
                    {largePartyMessage(page.largeParty.threshold)}
                  </p>
                  {(page.largeParty.contactPhone || page.largeParty.whatsappLink) && (
                    <div className="flex flex-wrap gap-2">
                      {page.largeParty.contactPhone && (
                        <a
                          className={cn(buttonVariants({ variant: "secondary" }), "tabular-nums")}
                          href={`tel:${page.largeParty.contactPhone}`}
                        >
                          <Phone aria-hidden className="size-[18px]" />
                          {displayPhone(page.largeParty.contactPhone)}
                        </a>
                      )}
                      {page.largeParty.whatsappLink && (
                        <a
                          className={buttonVariants({ variant: "secondary" })}
                          href={page.largeParty.whatsappLink}
                        >
                          <MessageCircle aria-hidden className="size-[18px]" />
                          Message us on WhatsApp
                        </a>
                      )}
                    </div>
                  )}
                </section>
              )}

              {times && party && date && (
                <section className={cn("flex flex-col gap-3", clearedWhenChanged)} aria-label="Available times">
                  <p className={cn(questionLabel, "m-0")}>
                    <Clock aria-hidden />
                    {`Available times on ${date.label}`}
                  </p>
                  <TimeGrid party={party} date={date.date} dateLabel={date.label} times={times} />
                </section>
              )}
            </Choices>
          )}
        </div>

        {details && (
          <div className="mt-7 lg:sticky lg:top-10 lg:mt-0">
            <DetailsForm
              action={action}
              party={details.party}
              date={details.date.date}
              dateLabel={details.date.label}
              contact={{ contactPhone, whatsappLink: page.whatsappLink }}
              turnstileSiteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || undefined}
            />
          </div>
        )}
      </BookingSteps>
    </main>
  );
}
