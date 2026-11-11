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

/** The per-IP limiter passes in a minute. The per-email ceiling on codes doesn't. */
export async function tooManyTriesMessage(response: Response) {
  const body = await response.json().catch(() => undefined);
  return body?.code === "sign_in_codes_paused"
    ? "We can't send or accept more codes for this email today. Use a sign-in link or Google instead."
    : "Too many tries. Wait a minute and try again.";
}

/**
 * Plain fetch rather than Better Auth's client: three calls don't need it. The
 * answer is the same whether or not an email is known, so the words are too.
 */
export function SignInForm({ audience, destination, page }: Props) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<Step>({ name: "start" });
  const [pending, setPending] = useState<Pending>();
  /** Signed in and on the way out: keep saying so until the page changes. */
  const [leaving, setLeaving] = useState<Pending>();
  const busy = pending !== undefined || leaving !== undefined;
  const urlError = useSearchParams().get("error");
  // The words outlive the message being shown, so they stay in the closing
  // Reveal while it folds away.
  const [message, setMessage] = useState(messageFor(urlError));
  const [showMessage, setShowMessage] = useState(Boolean(message));
  const error = showMessage ? message : undefined;
  const setError = (next: string | undefined) => {
    if (next) setMessage(next);
    setShowMessage(Boolean(next));
  };

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
      if (response.status === 429) {
        setError(await tooManyTriesMessage(response));
      }
      return response;
    } catch {
      setError("We couldn't reach the server. Check your connection.");
    } finally {
      setPending(undefined);
    }
  }

  async function sendLink() {
    const response = await post(
      "/sign-in/magic-link",
      { email, callbackURL: destination, errorCallbackURL: page },
      "link",
    );
    if (response?.ok) setStep({ name: "link-sent" });
  }

  async function sendCode() {
    const response = await post(
      "/email-otp/send-verification-otp",
      { email, type: "sign-in" },
      "code",
    );
    if (response?.ok) {
      setCode("");
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
    if (response && response.status !== 429) {
      setError("That code didn't work. Check it, or ask for a new one.");
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
    const url = response?.ok ? (await response.json()).url : undefined;
    if (url) {
      setLeaving("google");
      window.location.assign(url);
    }
  }

  const goBack = () => {
    setError(undefined);
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
          </Notice>
        </div>
        {differentEmail}
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
            onClick={sendCode}
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
