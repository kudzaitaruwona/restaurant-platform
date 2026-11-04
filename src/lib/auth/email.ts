/**
 * Sending sign-in emails. Everything else depends on this interface, so moving
 * off the proposed provider (D-09) means one more sender here and nothing else.
 */
export type Email = { to: string; subject: string; text: string };

export interface EmailSender {
  send(email: Email): Promise<void>;
}

/** Resend's HTTP API. One POST, so it doesn't need their SDK. */
export function resendSender(apiKey: string, from: string): EmailSender {
  return {
    async send({ to, subject, text }) {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
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
