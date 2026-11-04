"use client";

import { type FormEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Field, inputClassName } from "@/app/dashboard/field";
import type { Confirmation, TimeChoice } from "@/lib/bookings";
import { postForm } from "@/lib/form-response";

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

const noSubscription = () => () => {};
/** False in the server's markup and until the browser has hydrated the form. */
const useHydrated = () =>
  useSyncExternalStore(noSubscription, () => true, () => false);

type Refusal = {
  error: string;
  times?: TimeChoice[];
  contactPhone?: string | null;
  whatsappLink?: string | null;
};

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
  time: firstChoice,
  turnstileSiteKey,
}: {
  action: string;
  party: number;
  date: string;
  dateLabel: string;
  time: string;
  turnstileSiteKey?: string;
}) {
  const [time, setTime] = useState(firstChoice);
  const [refusal, setRefusal] = useState<Refusal>();
  const { container: turnstileContainer, token: turnstileToken } = useTurnstile(turnstileSiteKey);
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [pending, setPending] = useState(false);
  // Until the script is running, a submit would be a native post and the guest
  // would see raw JSON. The post is safe (method and action below: nothing goes in
  // a URL, and without party, date and time the route stores nothing), but a
  // disabled button spares them the JSON.
  const hydrated = useHydrated();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
      if (response.ok) setConfirmation(answer.confirmation);
      else setRefusal(answer);
    } catch {
      setRefusal({ error: "That didn't reach the restaurant. Try again." });
    } finally {
      setPending(false);
    }
  }

  if (confirmation) return <Confirmed confirmation={confirmation} />;

  return (
    <form method="post" action={action} onSubmit={submit}>
      <fieldset disabled={pending} className="flex flex-col gap-3">
        <legend className="mb-3 text-sm font-medium">
          Table for {party} on {dateLabel} at {time}
        </legend>
        <Field label="Name">
          <input name="name" required maxLength={100} autoComplete="name" className={inputClassName} />
        </Field>
        <div className="grid grid-cols-[5rem_1fr] gap-2">
          <Field label="Code">
            <input
              name="countryCode"
              required
              defaultValue="+263"
              inputMode="tel"
              autoComplete="tel-country-code"
              className={inputClassName}
            />
          </Field>
          <Field label="WhatsApp number">
            <input
              name="phone"
              type="tel"
              required
              autoComplete="tel-national"
              className={inputClassName}
            />
          </Field>
        </div>
        <Field label="Note (optional)">
          <textarea name="note" maxLength={200} rows={2} className={inputClassName} />
        </Field>
        <label className="flex items-start gap-2 text-sm">
          <input name="consent" type="checkbox" required className="mt-0.5" />
          Send my confirmation and reminder on WhatsApp.
        </label>
        <button
          type="submit"
          disabled={!hydrated}
          className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
        >
          Confirm booking
        </button>
        <div ref={turnstileContainer} />
        {refusal && (
          <div role="alert" className="flex flex-col gap-2 text-sm">
            <p className="text-destructive">{refusal.error}</p>
            {(refusal.contactPhone || refusal.whatsappLink) && (
              <p className="flex flex-wrap gap-x-4">
                {refusal.contactPhone && (
                  <a className="underline" href={`tel:${refusal.contactPhone}`}>
                    {refusal.contactPhone}
                  </a>
                )}
                {refusal.whatsappLink && (
                  <a className="underline" href={refusal.whatsappLink}>
                    Message us on WhatsApp
                  </a>
                )}
              </p>
            )}
            {refusal.times && refusal.times.length > 0 && (
              <ul className="flex flex-wrap gap-2">
                {refusal.times.map((choice) => (
                  <li key={choice.time}>
                    <button
                      type="button"
                      onClick={() => {
                        setTime(choice.time);
                        setRefusal(undefined);
                      }}
                      className="rounded-md border px-3 py-1.5"
                    >
                      {choice.time}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </fieldset>
    </form>
  );
}

export function Confirmed({ confirmation }: { confirmation: Confirmation }) {
  const { restaurantName, dateLabel, time, party, manageToken, contactPhone } = confirmation;
  return (
    <section role="status" className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">You&apos;re booked</h2>
      <p>
        {restaurantName}, {dateLabel} at {time}, party of {party}.
      </p>
      {contactPhone && (
        <p className="text-muted-foreground">
          Need anything? Call <a className="underline" href={`tel:${contactPhone}`}>{contactPhone}</a>.
        </p>
      )}
      <a className="text-sm underline" href={`/b/${manageToken}`}>
        Cancel booking
      </a>
    </section>
  );
}
