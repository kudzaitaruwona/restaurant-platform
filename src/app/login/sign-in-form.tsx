"use client";

import { useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";

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
  const [busy, setBusy] = useState(false);
  const urlError = useSearchParams().get("error");
  const [error, setError] = useState(messageFor(urlError));

  async function post(path: string, body: unknown) {
    setBusy(true);
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
      setBusy(false);
    }
  }

  async function sendLink() {
    const response = await post("/sign-in/magic-link", {
      email,
      callbackURL: destination,
      errorCallbackURL: page,
    });
    if (response?.ok) setStep({ name: "link-sent" });
  }

  async function sendCode() {
    const response = await post("/email-otp/send-verification-otp", {
      email,
      type: "sign-in",
    });
    if (response?.ok) setStep({ name: "enter-code" });
  }

  async function signInWithCode(event: FormEvent) {
    event.preventDefault();
    const response = await post("/sign-in/email-otp", { email, otp: code });
    if (response?.ok) window.location.assign(destination);
    else if (response && response.status !== 429) {
      setError("That code didn't work. Check it, or ask for a new one.");
    }
  }

  async function signInWithGoogle() {
    const response = await post("/sign-in/social", {
      provider: "google",
      callbackURL: destination,
      errorCallbackURL: page,
    });
    const url = response?.ok ? (await response.json()).url : undefined;
    if (url) window.location.assign(url);
  }

  const notice = error && (
    <p role="alert" className="text-sm text-destructive">
      {error}
    </p>
  );

  if (step.name === "link-sent") {
    return (
      <div className="flex flex-col gap-3">
        <p>
          If {email} can sign in here, a link is on its way. It expires in 10
          minutes.
        </p>
        <Button variant="outline" onClick={() => setStep({ name: "start" })}>
          Use a different email
        </Button>
      </div>
    );
  }

  if (step.name === "enter-code") {
    return (
      <form onSubmit={signInWithCode} className="flex flex-col gap-3">
        <p>
          If {email} can sign in here, a 6-digit code is on its way. It expires
          in 10 minutes.
        </p>
        <label className="flex flex-col gap-1 text-sm">
          Code
          <input
            value={code}
            onChange={(event) => setCode(event.target.value.trim())}
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            autoFocus
            className="rounded-md border px-3 py-2 text-base tracking-widest"
          />
        </label>
        {notice}
        <Button type="submit" disabled={busy}>
          Sign in
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => setStep({ name: "start" })}
        >
          Use a different email
        </Button>
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void sendLink();
        }}
        className="flex flex-col gap-3"
      >
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            required
            className="rounded-md border px-3 py-2 text-base"
          />
        </label>
        {notice}
        <Button type="submit" disabled={busy}>
          Email me a sign-in link
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy || !email}
          onClick={sendCode}
        >
          Email me a code instead
        </Button>
      </form>
      <Button
        type="button"
        variant="outline"
        disabled={busy}
        onClick={signInWithGoogle}
      >
        Sign in with Google
      </Button>
    </div>
  );
}
