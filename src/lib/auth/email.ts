import { getEnv } from "@/lib/env";

/**
 * Sending sign-in and invite emails. Everything else depends on this interface,
 * so moving off the proposed provider (D-09) means one more sender here and
 * nothing else.
 */
export type Email = { to: string; subject: string; text: string };

export interface EmailSender {
  send(email: Email): Promise<void>;
}

/** Well past a normal send, and short of holding a function open until it's killed. */
const SEND_TIMEOUT_MS = 10_000;

/** Resend's HTTP API. One POST, so it doesn't need their SDK. */
export function resendSender(apiKey: string, from: string): EmailSender {
  return {
    async send({ to, subject, text }) {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ from, to: [to], subject, text }),
      });
      // Only the status: the body can quote the recipient.
      if (!response.ok) throw new Error(`Resend answered ${response.status}`);
    },
  };
}

/** Development only: prints the email, so sign-in works with no account. */
export const consoleSender: EmailSender = {
  async send({ to, subject, text }) {
    console.info(`\n--- Email to ${to}: ${subject}\n${text}\n---\n`);
  },
};

/** Resend when it's configured (always, in production), the console otherwise. */
export function emailSender(): EmailSender {
  const { RESEND_API_KEY, EMAIL_FROM } = getEnv();
  if (RESEND_API_KEY && EMAIL_FROM) {
    return resendSender(RESEND_API_KEY, EMAIL_FROM);
  }
  return consoleSender;
}

/** The working name (D-08), until the product has its own. */
export const APP_NAME = "restaurant-platform";

export function signInLinkEmail(to: string, url: string, minutes: number): Email {
  return {
    to,
    subject: "Your sign-in link",
    text: `Open this link to sign in. It works once and expires in ${minutes} minutes.\n\n${url}\n\nIf you didn't ask for this, you can ignore this email.`,
  };
}

export function signInCodeEmail(to: string, code: string, minutes: number): Email {
  return {
    to,
    subject: `Your sign-in code: ${code}`,
    text: `Your sign-in code is ${code}. It expires in ${minutes} minutes.\n\nIf you didn't ask for this, you can ignore this email.`,
  };
}

/**
 * Where an invite sends someone (S-42): the ordinary sign-in page with their
 * email filled in. Nothing secret: signing in still emails them a link or code.
 */
export function inviteLink(appUrl: string, email: string) {
  const url = new URL("/login", appUrl);
  url.searchParams.set("email", email);
  return url.toString();
}

const firstNameOf = (name: string) => name.trim().split(/\s+/)[0];

const howToSignIn = (to: string, appUrl: string) =>
  `Sign in with this email address, ${to}:\n\n${inviteLink(appUrl, to)}\n\n` +
  "You will get a sign-in link or a code by email. There is no password.";

/** To someone a restaurant has just added (S-42). */
export function staffInviteEmail({
  to,
  name,
  restaurantName,
  addedBy,
  role,
  appUrl,
}: {
  to: string;
  name: string;
  restaurantName: string;
  /** Who added them, as their colleagues know them. */
  addedBy: string;
  role: "owner" | "staff";
  appUrl: string;
}): Email {
  const joining = role === "owner" ? " as an owner" : "";
  return {
    to,
    subject: `${addedBy} added you to ${restaurantName}`,
    text:
      `Hi ${firstNameOf(name)},\n\n${addedBy} added you to ${restaurantName}${joining} on ${APP_NAME}.\n\n` +
      howToSignIn(to, appUrl),
  };
}

/** To a restaurant's first owner, whom the platform admin has just created (S-42). */
export function ownerInviteEmail({
  to,
  name,
  restaurantName,
  appUrl,
}: {
  to: string;
  name: string;
  restaurantName: string;
  appUrl: string;
}): Email {
  return {
    to,
    subject: `${restaurantName} is ready for you`,
    text:
      `Hi ${firstNameOf(name)},\n\n${restaurantName} is set up for you on ${APP_NAME}. You are its owner.\n\n` +
      howToSignIn(to, appUrl),
  };
}
