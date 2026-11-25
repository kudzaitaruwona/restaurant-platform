"use client";

import { LoaderCircle, MailCheck } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Field, inputClassName } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { cn } from "@/lib/utils";
import { pressable, Reveal, StepPanel } from "../motion";
import { CodeInput } from "./code-input";

type Props = {
  /** Which session this signs in to: "staff" or "admin". */
  audience: "staff" | "admin";
  /** Where to go once signed in. */
  destination: string;
  /** This page, for Better Auth to come back to with an error. */
  page: string;
};

type Step =
  | { name: "start" }
  | { name: "link-sent" }
  | { name: "enter-code" };

/** Which button is working, so only that one says so. */
type Pending = "link" | "code" | "verify" | "google";

const refused =
  "We couldn't sign you in. Check this is the email your restaurant has for you.";
const expired = "That link has expired or was already used. Ask for a new one.";

const messageFor = (error: string | null) => {
  if (!error) return undefined;
  return error === "sign_in_refused" ? refused : expired;
};

/** 254 characters is the most an address can have. */
const invitedEmail = (value: string | null) =>
  value && value.length <= 254 ? value.trim() : "";

/** The per-IP limiter passes in a minute. The per-email ceiling on codes doesn't. */
export async function tooManyTriesMessage(response: Response) {
  const body = await response.json().catch(() => undefined);
  return body?.code === "sign_in_codes_paused"
    ? "We can't send or accept more codes for this email today. Use a sign-in link or Google instead."
    : "Too many tries. Wait a minute and try again.";
}

/** Better Auth burns a code after this many wrong tries (`allowedAttempts`). */
export const WRONG_TRIES_ALLOWED = 3;
/** Seconds before "send a new one" is offered again. The server's limits still apply. */
const RESEND_COOLDOWN_SECONDS = 30;

type Way = "link" | "code" | "google";

const couldntSend: Record<Way, string> = {
  link: "We couldn't send a sign-in link just now. Try again in a moment.",
  code: "We couldn't send a code just now. Try again in a moment.",
  google: "We couldn't start Google sign-in. Try again, or use a link or code.",
};

/**
 * Catches what plainly isn't an address before a send is spent on it. Stricter
 * than the browser's email field, which takes a@b; the server has the last word.
 */
export const looksLikeEmail = (value: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

/**
 * Words for a send or Google start that didn't work. The server answers the same
 * whether or not an email is known, so nothing here can say who is: a failure
 * is either a bad address, a limit, or ours.
 */
export async function sendFailureMessage(response: Response, way: Way) {
  if (response.status === 429) return tooManyTriesMessage(response);
  const body = await response.clone().json().catch(() => undefined);
  // The link route validates its body, and the address is all a person typed in it.
  const badBody = response.status === 400 && body?.code === "VALIDATION_ERROR";
  if (body?.code === "INVALID_EMAIL" || (badBody && way !== "google")) {
    return INVALID_EMAIL_MESSAGE;
  }
  return couldntSend[way];
}

const INVALID_EMAIL_MESSAGE = "Enter a valid email address.";

/** Only these use up a code. A failure of ours, or a limit, says nothing about it. */
export async function isWrongTry(response: Response) {
  const body = await response.clone().json().catch(() => undefined);
  return body?.code === "INVALID_OTP";
}

/** Words for a code that didn't sign anyone in. `wrongTries` counts this one if it was wrong. */
export async function codeFailureMessage(response: Response, wrongTries: number) {
  if (response.status === 429) return tooManyTriesMessage(response);
  const body = await response.clone().json().catch(() => undefined);
  if (body?.code === "sign_in_refused") return refused;
  if (body?.code === "TOO_MANY_ATTEMPTS" || wrongTries >= WRONG_TRIES_ALLOWED) {
    return "That code has been used up after too many wrong tries. Request a new one.";
  }
  if (body?.code === "OTP_EXPIRED") return "That code has expired. Request a new one.";
  return "That code didn't work. Check it, or request a new one.";
}

/** "Send a new code", waiting out a short cooldown so it isn't pressed in a row. */
export function ResendButton({
  what,
  seconds,
  busy,
  onClick,
}: {
  what: "code" | "link";
  seconds: number;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="secondary"
      size="staff"
      className={cn("w-full", pressable)}
      disabled={busy || seconds > 0}
      onClick={onClick}
    >
      {seconds > 0 ? `Send a new ${what} in ${seconds}s` : `Send a new ${what}`}
    </Button>
  );
}

/**
 * Plain fetch rather than Better Auth's client: three calls don't need it. The
 * answer is the same whether or not an email is known, so the words are too.
 */
export function SignInForm({ audience, destination, page }: Props) {
  const searchParams = useSearchParams();
  // An invite links here with the address filled in (S-42). Only filled in: it
  // still has to be asked for, and the answer is the same as for anyone.
  const [email, setEmail] = useState(() => invitedEmail(searchParams.get("email")));
  const [code, setCode] = useState("");
  const [step, setStep] = useState<Step>({ name: "start" });
  const [pending, setPending] = useState<Pending>();
  const [cooldown, setCooldown] = useState(0);
  const [wrongTries, setWrongTries] = useState(0);
  /** Said after a resend, so it's clear another one went. */
  const [resent, setResent] = useState(false);
  /** Signed in and on the way out: keep saying so until the page changes. */
  const [leaving, setLeaving] = useState<Pending>();
  const busy = pending !== undefined || leaving !== undefined;
  const urlError = searchParams.get("error");
  // The words outlive the message being shown, so they stay in the closing
  // Reveal while it folds away.
  const [message, setMessage] = useState(messageFor(urlError));
  const [showMessage, setShowMessage] = useState(Boolean(message));
  const error = showMessage ? message : undefined;
  const setError = (next: string | undefined) => {
    if (next) setMessage(next);
    setShowMessage(Boolean(next));
  };

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const emailInput = useRef<HTMLInputElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const sentNotice = useRef<HTMLDivElement>(null);
  const firstRender = useRef(true);

  // Move focus with the step: to the message on "link sent" (so it is read
  // out), and back to the email when going back. Not on first load, so a
  // phone's keyboard doesn't jump up over the page.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (step.name === "start") emailInput.current?.focus();
    if (step.name === "link-sent") sentNotice.current?.focus();
  }, [step.name]);

  async function post(path: string, body: unknown, action: Pending) {
    setPending(action);
    setError(undefined);
    try {
      const response = await fetch(`/api/auth/${audience}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return response;
    } catch {
      setError("We couldn't reach the server. Check your connection.");
    } finally {
      setPending(undefined);
    }
  }

  /** The address has to look like one on every way in, not just the form's own submit. */
  function emailIsValid() {
    if (looksLikeEmail(email)) return true;
    setError(INVALID_EMAIL_MESSAGE);
    emailInput.current?.focus();
    return false;
  }

  /** True when it went; otherwise says why, whatever the status was. */
  async function send(path: string, body: unknown, way: Pending & Way) {
    const response = await post(path, body, way);
    if (response?.ok) {
      setCooldown(RESEND_COOLDOWN_SECONDS);
      return true;
    }
    if (response) setError(await sendFailureMessage(response, way));
    return false;
  }

  async function sendLink(again = false) {
    if (!again && !emailIsValid()) return;
    const sent = await send(
      "/sign-in/magic-link",
      { email, callbackURL: destination, errorCallbackURL: page },
      "link",
    );
    setResent(sent && again);
    if (sent) setStep({ name: "link-sent" });
  }

  async function sendCode(again = false) {
    if (!again && !emailIsValid()) return;
    const sent = await send(
      "/email-otp/send-verification-otp",
      { email, type: "sign-in" },
      "code",
    );
    setResent(sent && again);
    if (sent) {
      setCode("");
      setWrongTries(0);
      setStep({ name: "enter-code" });
    }
  }

  async function signInWithCode(otp: string) {
    if (busy) return;
    const response = await post("/sign-in/email-otp", { email, otp }, "verify");
    if (response?.ok) {
      setLeaving("verify");
      window.location.assign(destination);
      return;
    }
    if (response) {
      const tries = wrongTries + ((await isWrongTry(response)) ? 1 : 0);
      setWrongTries(tries);
      setError(await codeFailureMessage(response, tries));
    }
    // Clear it and hand the field back, ready for the next try.
    setCode("");
    codeInput.current?.focus();
  }

  async function signInWithGoogle() {
    const response = await post(
      "/sign-in/social",
      { provider: "google", callbackURL: destination, errorCallbackURL: page },
      "google",
    );
    const url = response?.ok
      ? await response.json().then((body) => body?.url as string | undefined, () => undefined)
      : undefined;
    if (url) {
      setLeaving("google");
      window.location.assign(url);
    } else if (response) {
      setError(
        response.ok
          ? couldntSend.google
          : await sendFailureMessage(response, "google"),
      );
    }
  }

  const goBack = () => {
    setError(undefined);
    setResent(false);
    setStep({ name: "start" });
  };

  /** The error slot: always there, opening in place under its field. */
  const notice = (
    <Reveal open={Boolean(error)}>
      <div className="pt-3">
        {message && (
          <Notice role={error ? "alert" : undefined} tone="danger">
            {message}
          </Notice>
        )}
      </div>
    </Reveal>
  );

  /** A label that swaps for a working one without moving anything. */
  const label = (action: Pending, idle: ReactNode, working: ReactNode) =>
    pending === action || leaving === action ? (
      <>
        <LoaderCircle
          aria-hidden
          className="animate-spin [animation-duration:700ms] motion-reduce:animate-none"
        />
        {working}
      </>
    ) : (
      idle
    );

  const button = cn("w-full", pressable);

  const differentEmail = (
    <Button
      type="button"
      variant="ghost"
      size="staff"
      className={button}
      disabled={busy}
      onClick={goBack}
    >
      Use a different email
    </Button>
  );

  if (step.name === "link-sent") {
    return (
      <StepPanel key="link-sent" className="flex flex-col gap-4">
        <div ref={sentNotice} tabIndex={-1} className="rounded-control outline-none">
          <Notice role="status" icon={<MailCheck />}>
            If <span className="font-semibold break-all">{email}</span> can sign in
            here, a link is on its way. It expires in 10 minutes.
            {resent && " We sent another."}
          </Notice>
        </div>
        {notice}
        <div className="flex flex-col gap-2">
          <ResendButton
            what="link"
            seconds={cooldown}
            busy={busy}
            onClick={() => void sendLink(true)}
          />
          {differentEmail}
        </div>
      </StepPanel>
    );
  }

  if (step.name === "enter-code") {
    return (
      <StepPanel key="enter-code">
        <form
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void signInWithCode(code);
          }}
          className="flex flex-col gap-4"
        >
          <Notice role="status" icon={<MailCheck />}>
            If <span className="font-semibold break-all">{email}</span> can sign in
            here, a 6-digit code is on its way. It expires in 10 minutes.
            {resent && " We sent another."}
          </Notice>
          <div className="flex flex-col">
            <Field label="Code">
              <CodeInput
                ref={codeInput}
                value={code}
                onChange={(next) => {
                  setCode(next);
                  if (error) setError(undefined);
                }}
                onComplete={(full) => void signInWithCode(full)}
                invalid={Boolean(error)}
                disabled={busy}
              />
            </Field>
            {notice}
          </div>
          <div className="flex flex-col gap-2">
            <Button type="submit" size="staff" className={button} disabled={busy}>
              {label("verify", "Sign in", "Signing in")}
            </Button>
            <ResendButton
              what="code"
              seconds={cooldown}
              busy={busy}
              onClick={() => void sendCode(true)}
            />
            {differentEmail}
          </div>
        </form>
      </StepPanel>
    );
  }

  return (
    <StepPanel key="start" className="flex flex-col gap-4">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void sendLink();
        }}
        className="flex flex-col gap-4"
      >
        <div className="flex flex-col">
          <Field label="Email">
            <input
              ref={emailInput}
              className={inputClassName}
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              required
              readOnly={busy}
              aria-invalid={error ? true : undefined}
            />
          </Field>
          {notice}
        </div>
        <div className="flex flex-col gap-2">
          <Button type="submit" size="staff" className={button} disabled={busy}>
            {label("link", "Email me a sign-in link", "Sending the link")}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="staff"
            className={button}
            disabled={busy || !email}
            onClick={() => void sendCode()}
          >
            {label("code", "Email me a code instead", "Sending a code")}
          </Button>
        </div>
      </form>
      <div className="flex items-center gap-3 text-caption text-ink-2" aria-hidden>
        <span className="h-px flex-1 bg-line" />
        or
        <span className="h-px flex-1 bg-line" />
      </div>
      <Button
        type="button"
        variant="secondary"
        size="staff"
        className={button}
        disabled={busy}
        onClick={signInWithGoogle}
      >
        {label("google", "Sign in with Google", "Going to Google")}
      </Button>
    </StepPanel>
  );
}
