"use client";

import { type FormEvent, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { Calendar, MessageCircle, Phone } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { inputClassName } from "@/components/ui/input";
import type { Confirmation, TimeChoice } from "@/lib/bookings";
import { displayPhone } from "@/lib/display-phone";
import { postForm } from "@/lib/form-response";
import { cn } from "@/lib/utils";
import { useSteps } from "./booking-steps";
import { bookedPath, forgetBooked, rememberBooked, useCanGoForward } from "./just-booked";
import { byPeriod } from "./times";

/** The part of Cloudflare's script this form uses. */
type TurnstileApi = {
  render: (container: HTMLElement, options: Record<string, unknown>) => string;
  execute: (widget: string) => void;
  reset: (widget: string) => void;
};
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}
const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const TURNSTILE_FIELD = "cf-turnstile-response";
/** How long a guest waits for the check before the form posts without a token. */
const TURNSTILE_WAIT_MS = 10_000;

/**
 * The invisible bot check (spec 04, proposed): Cloudflare's script is loaded here,
 * on the guest's page only, and only when a site key is set. It runs when the guest
 * confirms, not before, so it costs nothing to someone who only looks. The token it
 * returns goes in the post and nowhere else. If the script can't load, the post goes
 * without a token and the server decides what that means.
 */
function useTurnstile(siteKey: string | undefined) {
  const container = useRef<HTMLDivElement>(null);
  const widget = useRef<string>(undefined);
  const waiting = useRef<(token: string | undefined) => void>(undefined);

  useEffect(() => {
    if (!siteKey || !container.current) return;
    const mount = () => {
      if (!window.turnstile || !container.current || widget.current) return;
      widget.current = window.turnstile.render(container.current, {
        sitekey: siteKey,
        execution: "execute",
        appearance: "interaction-only",
        callback: (token: string) => waiting.current?.(token),
        "error-callback": () => waiting.current?.(undefined),
      });
    };
    let script = document.querySelector<HTMLScriptElement>("script[data-turnstile]");
    if (!script) {
      script = document.createElement("script");
      script.src = TURNSTILE_SCRIPT;
      script.async = true;
      script.dataset.turnstile = "";
      document.head.append(script);
    }
    if (window.turnstile) mount();
    else script.addEventListener("load", mount);
    return () => script.removeEventListener("load", mount);
  }, [siteKey]);

  /** A fresh token, or undefined when there is no check, or it didn't come. */
  const token = () =>
    new Promise<string | undefined>((resolve) => {
      const id = widget.current;
      if (!id || !window.turnstile) return resolve(undefined);
      const timer = setTimeout(() => resolve(undefined), TURNSTILE_WAIT_MS);
      waiting.current = (value) => {
        clearTimeout(timer);
        waiting.current = undefined;
        resolve(value);
      };
      window.turnstile.reset(id); // a token works once
      window.turnstile.execute(id);
    });

  return { container, token };
}

/** The guest's filled control (S-41): grey until focused, then the surface. */
const filled = cn(inputClassName, "border-transparent bg-surface-2 text-[16px] focus:bg-surface");
const fieldLabel = "text-body font-medium text-ink";

const noSubscription = () => () => {};
/** False in the server's markup and until the browser has hydrated the form. */
const useHydrated = () =>
  useSyncExternalStore(noSubscription, () => true, () => false);

type Contact = { contactPhone: string | null; whatsappLink: string | null };
type Refusal = {
  error: string;
  times?: TimeChoice[];
  available?: TimeChoice[];
} & Partial<Contact>;

/**
 * The answer as it is shown. The rate limit answers before the restaurant is looked
 * up, so the number to ring instead is the one this page already has (#103).
 */
export const refusalOf = (status: number, answer: Refusal, contact: Contact): Refusal =>
  status === 429 ? { ...contact, ...answer } : answer;

/**
 * The details step and what follows it. A refusal shows here with everything the
 * guest typed still in place, and a nearest time swaps in without losing it. Nothing
 * they typed goes in a URL.
 */
export function DetailsForm({
  action,
  party,
  date,
  dateLabel,
  contact,
  turnstileSiteKey,
}: {
  action: string;
  party: number;
  date: string;
  dateLabel: string;
  contact: Contact;
  turnstileSiteKey?: string;
}) {
  const { time, setTime, setAvailable, pending, setPending, booked, setBooked, leftOver } = useSteps();
  const [refusal, setRefusal] = useState<Refusal>();
  const summary = useRef<HTMLSpanElement>(null);
  // Until the script is running, a submit would be a native post and the guest
  // would see raw JSON. The post is safe (method and action below: nothing goes in
  // a URL, and without party, date and time the route stores nothing), but a
  // disabled button spares them the JSON.
  const hydrated = useHydrated();
  // Not before hydration, which is when a left-over form is known to be one.
  const { container: turnstileContainer, token: turnstileToken } = useTurnstile(
    hydrated && !leftOver ? turnstileSiteKey : undefined,
  );
  const id = useId();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!time) return;
    const body = new FormData(event.currentTarget); // before the fieldset disables its controls
    body.set("party", String(party));
    body.set("date", date);
    body.set("time", time);
    setPending(true);
    setRefusal(undefined);
    try {
      const token = await turnstileToken();
      if (token) body.set(TURNSTILE_FIELD, token);
      const response = await postForm(action, body);
      const answer = await response.json();
      if (response.ok) {
        // Replaced, so Back can't return to this form (#89).
        const path = bookedPath((answer.confirmation as Confirmation).manageToken);
        rememberBooked(action);
        setBooked(path);
        window.location.replace(path);
      } else {
        setRefusal(refusalOf(response.status, answer, contact));
        if (answer.available) {
          const left = answer.available as TimeChoice[];
          setAvailable(left);
          if (!left.some((choice) => choice.time === time)) setTime(undefined);
        }
      }
    } catch {
      setRefusal({ error: "That didn't reach the restaurant. Try again." });
    } finally {
      setPending(false);
    }
  }

  // A new page, not just the form shown again: the bot check's widget went with it.
  function startAgain() {
    forgetBooked(action);
    window.location.reload();
  }

  if (booked || leftOver) {
    return (
      <AlreadyBooked
        open={booked ? () => window.location.replace(booked) : undefined}
        again={booked ? undefined : startAgain}
      />
    );
  }

  return (
    <form
      id="details"
      method="post"
      action={action}
      onSubmit={submit}
      // Hidden with the times it belongs to (clearedWhenChanged, page.tsx).
      className="scroll-mt-4 rounded-card border border-line bg-surface px-4 py-5 group-has-[[data-loaded]:not(:checked)]/steps:hidden"
    >
      <fieldset disabled={pending} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
        <legend className="mb-4 flex w-full items-center gap-3 border-b border-line p-0 pb-4">
          <span className="grid size-10 shrink-0 place-items-center rounded-control bg-brand-soft text-ink">
            <Calendar aria-hidden className="size-5" />
          </span>
          <span className="flex flex-col">
            <span
              ref={summary}
              tabIndex={-1}
              className="scroll-mt-8 text-lead font-semibold text-ink outline-none"
            >
              Table for {party} on {dateLabel}
              {time && (
                <>
                  {" "}
                  at <span className="tabular-nums">{time}</span>
                </>
              )}
            </span>
            <span className="text-caption text-ink-2">Your details, then confirm.</span>
          </span>
        </legend>
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Name</span>
          <input name="name" required maxLength={100} autoComplete="name" className={filled} />
        </label>
        <div role="group" aria-labelledby={`${id}-phone`} className="flex flex-col gap-1.5">
          <span id={`${id}-phone`} className={fieldLabel}>
            WhatsApp number
          </span>
          <div className="grid grid-cols-[76px_minmax(0,1fr)] gap-2">
            <input
              name="countryCode"
              required
              defaultValue="+263"
              inputMode="tel"
              autoComplete="tel-country-code"
              aria-label="Country code"
              className={cn(filled, "tabular-nums")}
            />
            <input
              name="phone"
              type="tel"
              required
              autoComplete="tel-national"
              aria-labelledby={`${id}-phone`}
              placeholder="77 200 0004"
              className={cn(filled, "tabular-nums")}
            />
          </div>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>
            Note <span className="font-normal text-ink-2">(optional)</span>
          </span>
          <textarea
            name="note"
            maxLength={200}
            rows={2}
            aria-describedby={`${id}-note`}
            className={cn(filled, "min-h-[72px] resize-y")}
          />
          <span id={`${id}-note`} className="text-caption text-ink-2">
            Up to 200 characters.
          </span>
        </label>
        <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-control bg-surface-2 p-3 text-body text-ink">
          <input
            name="consent"
            type="checkbox"
            required
            className="mt-px size-[22px] shrink-0 cursor-pointer accent-brand"
          />
          Send my confirmation and reminder on WhatsApp.
        </label>
        <button
          type="submit"
          disabled={!hydrated || !time}
          className={cn(buttonVariants({ variant: "primary" }), "h-12 w-full")}
        >
          {pending ? "Confirming" : time ? "Confirm booking" : "Choose another time"}
        </button>
        <div ref={turnstileContainer} className="flex justify-center empty:hidden" />
        {refusal && (
          <RefusalNotice
            refusal={refusal}
            choose={(choice) => {
              setTime(choice);
              setRefusal(undefined);
              // The button that had focus goes with the notice; this names the new time.
              summary.current?.focus();
            }}
          />
        )}
      </fieldset>
    </form>
  );
}

/** Why it wasn't booked. It comes up under the button, so it brings itself to the guest (#103). */
export function RefusalNotice({
  refusal,
  choose,
}: {
  refusal: Refusal;
  choose: (time: string) => void;
}) {
  const notice = useRef<HTMLDivElement>(null);
  useEffect(() => {
    notice.current?.focus({ preventScroll: true });
    notice.current?.scrollIntoView({ block: "center" });
  }, [refusal]);
  return (
    <div
      ref={notice}
      tabIndex={-1}
      role="alert"
      className="rounded-control outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Notice tone="attention">
        <div className="flex flex-col gap-3">
          <p>{refusal.error}</p>
          {(refusal.contactPhone || refusal.whatsappLink) && (
            <p className="flex flex-wrap gap-2">
              {refusal.contactPhone && (
                <a
                  className={cn(buttonVariants({ variant: "secondary" }), "tabular-nums")}
                  href={`tel:${refusal.contactPhone}`}
                >
                  <Phone aria-hidden className="size-[18px]" />
                  {displayPhone(refusal.contactPhone)}
                </a>
              )}
              {refusal.whatsappLink && (
                <a className={buttonVariants({ variant: "secondary" })} href={refusal.whatsappLink}>
                  <MessageCircle aria-hidden className="size-[18px]" />
                  Message us on WhatsApp
                </a>
              )}
            </p>
          )}
          {byPeriod(refusal.times ?? []).map(([period, slots]) => (
            <div key={period} className="flex flex-col gap-2">
              <p className="text-caption font-semibold text-ink-2">{period}</p>
              <ul className="m-0 grid list-none grid-cols-4 gap-2 p-0">
                {slots.map(({ time }) => (
                  <li key={time}>
                    <button
                      type="button"
                      aria-label={`${period}, ${time}`}
                      onClick={() => choose(time)}
                      className="grid h-11 w-full cursor-pointer place-items-center rounded-control border border-transparent bg-surface font-medium text-ink tabular-nums transition-colors duration-150 ease-out hover:border-line"
                    >
                      {time}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Notice>
    </div>
  );
}

/**
 * In the form's place once it has booked (#89): for the moment before the booking's
 * own page opens, and for a guest who comes Back to a form from before it. By then
 * the booking may be cancelled or past its cutoff, so that text claims neither.
 */
export function AlreadyBooked({ open, again }: { open?: () => void; again?: () => void }) {
  const canGoForward = useCanGoForward();
  return (
    <section
      id="details"
      role="status"
      className="flex scroll-mt-4 flex-col gap-3 rounded-card border border-line bg-surface px-4 py-5"
    >
      <h2 className="text-lead font-semibold text-ink">
        {again ? "You booked from this tab" : "You're booked"}
      </h2>
      <p className="text-body text-ink-2">
        {!again
          ? "Opening your booking."
          : canGoForward
            ? "Open that booking to see or cancel it, or use the link in your WhatsApp confirmation. If you have already cancelled it, you can make another booking."
            : "To see or cancel that booking, use the link in your WhatsApp confirmation. If you have already cancelled it, you can make another booking."}
      </p>
      {(open || canGoForward) && (
        <button
          type="button"
          onClick={open ?? (() => window.history.forward())}
          className={cn(buttonVariants({ variant: "primary" }), "h-12 w-full")}
        >
          {open ? "Open your booking" : "Forward to your booking"}
        </button>
      )}
      {again && (
        <button
          type="button"
          onClick={again}
          className={cn(buttonVariants({ variant: "secondary" }), "h-12 w-full")}
        >
          Make another booking
        </button>
      )}
    </section>
  );
}
