import type { Env } from "@/lib/env";
import { renderText, type TemplateMessage } from "./templates";

/**
 * Sending a template message (spec 05), behind one interface with two
 * implementations, chosen by configuration alone (chooseSender): turning
 * WhatsApp on is setting the WHATSAPP_* variables, with no code change.
 */

/** The Graph API version every call uses. Meta retires each about two years after release. */
export const GRAPH_API_VERSION = "v23.0";

const GRAPH_API_BASE_URL = "https://graph.facebook.com";
/** How long one send may wait for Meta. The job's time budget allows for one send this long past it. */
const REQUEST_TIMEOUT_MS = 10_000;
/** notifications.last_error holds at most this many characters. */
const MAX_ERROR_LENGTH = 500;

/**
 * `retryable` says whether the same message might go through in a few minutes
 * (#47): the job tries it again, up to 3 attempts in all, if so.
 */
export type SendResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; error: string; retryable: boolean };

export interface WhatsAppSender {
  /** Never throws: a failure is a result, with text for notifications.last_error. */
  send(message: TemplateMessage): Promise<SendResult>;
}

const failed = (error: string, retryable: boolean): SendResult => ({
  ok: false,
  error: error.slice(0, MAX_ERROR_LENGTH),
  retryable,
});

/**
 * Meta's throttling error codes (Graph API error codes): app or account rate
 * limits, throughput, and too many messages to one number. Waiting is the fix.
 */
const META_THROTTLING_CODES = new Set([4, 80007, 130429, 131056]);

/**
 * Worth trying again (#47): a request timeout, a rate limit, a 5xx, or one of
 * Meta's throttling codes. Any other 4xx is about the message, the number or our
 * credentials (an invalid number, a template that doesn't exist, an expired
 * token), and the same request would be refused again.
 */
const retryableAnswer = (status: number, code: unknown) =>
  status === 408 || status === 429 || status >= 500 || (typeof code === "number" && META_THROTTLING_CODES.has(code));

/**
 * The WhatsApp Cloud API: POST /{phone number id}/messages. Accepted means a 2xx
 * with `messages[0].id`, which becomes provider_message_id; anything else is a
 * failed send, marked retryable or not (retryableAnswer). A network error or a
 * timeout is retryable, although Meta may have taken the message: delivery is
 * at least once (src/lib/cron/notifications.ts).
 */
export function metaSender({
  phoneNumberId,
  accessToken,
  baseUrl = GRAPH_API_BASE_URL,
  timeoutMs = REQUEST_TIMEOUT_MS,
}: {
  phoneNumberId: string;
  accessToken: string;
  baseUrl?: string;
  timeoutMs?: number;
}): WhatsAppSender {
  const url = `${baseUrl}/${GRAPH_API_VERSION}/${encodeURIComponent(phoneNumberId)}/messages`;
  return {
    async send(message) {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
          body: JSON.stringify(requestBody(message)),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        return failed(`Meta request failed: ${error instanceof Error ? error.name : "unknown"}`, true);
      }
      const body = (await response.json().catch(() => undefined)) as MetaResponse | undefined;
      if (!response.ok) {
        const { message: text, code } = body?.error ?? {};
        return failed(
          typeof text === "string" ? `Meta ${response.status} (${code}): ${text}` : `Meta ${response.status}`,
          retryableAnswer(response.status, code),
        );
      }
      const id = body?.messages?.[0]?.id;
      // Not retried: Meta answered success, so it may have taken the message, and
      // an answer it keeps giving would message the guest on every attempt.
      if (typeof id !== "string" || id === "") return failed(`Meta ${response.status} without a message id`, false);
      return { ok: true, providerMessageId: id };
    },
  };
}

type MetaResponse = {
  messages?: { id?: unknown }[];
  error?: { message?: unknown; code?: unknown };
};

function requestBody(message: TemplateMessage) {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: message.to,
    type: "template",
    template: {
      name: message.template,
      language: { code: message.language },
      components: [
        { type: "body", parameters: message.body.map((text) => ({ type: "text", text })) },
        // The template's one button is a URL button to /b/{{1}}: the manage page.
        { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: message.manageToken }] },
      ],
    },
  };
}

/** Development without Meta's keys: prints the message, as sign-in prints its emails. */
export function consoleSender(): WhatsAppSender {
  return {
    async send(message) {
      console.info(`WhatsApp (console, not sent) to ${message.to}, ${message.template}:\n${renderText(message)}`);
      return { ok: true, providerMessageId: `console-${crypto.randomUUID()}` };
    },
  };
}

type SenderEnv = Partial<
  Pick<Env, "WHATSAPP_PHONE_NUMBER_ID" | "WHATSAPP_ACCESS_TOKEN" | "NODE_ENV" | "VERCEL_ENV">
>;

export type SenderChoice =
  | { kind: "meta" | "console"; sender: WhatsAppSender }
  /** Production without the keys: nothing is claimed, and due rows wait as pending. */
  | { kind: "hold"; missing: string[] };

/**
 * Meta when both credentials are set. Otherwise the console outside production,
 * and in production nothing: queued messages are held as pending and go once
 * the keys are added (the send-time status check drops any gone stale). One key
 * without the other is a half-made setup and holds everywhere, so a typo can't
 * quietly send to the console instead of the guest.
 */
export function chooseSender(env: SenderEnv): SenderChoice {
  const { WHATSAPP_PHONE_NUMBER_ID: phoneNumberId, WHATSAPP_ACCESS_TOKEN: accessToken } = env;
  if (phoneNumberId && accessToken) return { kind: "meta", sender: metaSender({ phoneNumberId, accessToken }) };
  const production = env.NODE_ENV === "production" || env.VERCEL_ENV === "production";
  if (!phoneNumberId && !accessToken && !production) return { kind: "console", sender: consoleSender() };
  return {
    kind: "hold",
    missing: [
      ...(phoneNumberId ? [] : ["WHATSAPP_PHONE_NUMBER_ID"]),
      ...(accessToken ? [] : ["WHATSAPP_ACCESS_TOKEN"]),
    ],
  };
}
