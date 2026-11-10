import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * The pure half of Meta's webhook (spec 05, Delivery status): proving a call is
 * Meta's, the subscription handshake, and reading delivery statuses out of a
 * callback. No database: src/lib/whatsapp/delivery-status.ts writes them.
 */

/** The statuses the webhook records. Meta also sends others (e.g. `deleted`), which are ignored. */
export const DELIVERY_STATUSES = ["sent", "delivered", "read", "failed"] as const;
export type DeliveryStatusName = (typeof DELIVERY_STATUSES)[number];

export type DeliveryStatus = {
  providerMessageId: string;
  status: DeliveryStatusName;
  /** For `failed`: Meta's first error, for notifications.last_error. */
  error?: string;
};

/** notifications.last_error holds at most this many characters. */
const MAX_ERROR_LENGTH = 500;
const SIGNATURE = /^sha256=([0-9a-f]{64})$/;

/**
 * Whether `X-Hub-Signature-256` is the HMAC-SHA256 of the raw body under the
 * app secret, compared in constant time. Fails closed: with no secret set,
 * nothing is Meta's, so a deployment without WHATSAPP_APP_SECRET takes no
 * status at all (Meta retries, so they arrive once it is set).
 */
export function isSignedByMeta(rawBody: Uint8Array, header: string | null, secret: string | undefined) {
  if (!secret || header === null) return false;
  const match = SIGNATURE.exec(header);
  if (!match) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return timingSafeEqual(Buffer.from(match[1], "hex"), expected);
}

const digest = (value: string) => createHash("sha256").update(value).digest();
/** Meta's challenge is a number; anything else isn't echoed back. */
const CHALLENGE = /^[0-9A-Za-z_-]{1,128}$/;

/**
 * Meta's subscription handshake: `hub.mode=subscribe`, `hub.verify_token` and
 * `hub.challenge`. The challenge comes back when the token matches the one set
 * in WHATSAPP_WEBHOOK_VERIFY_TOKEN (compared as digests, in constant time);
 * null otherwise, and always with no token set.
 */
export function verificationChallenge(params: URLSearchParams, verifyToken: string | undefined) {
  if (!verifyToken) return null;
  const challenge = params.get("hub.challenge");
  if (params.get("hub.mode") !== "subscribe" || challenge === null || !CHALLENGE.test(challenge)) return null;
  const given = params.get("hub.verify_token") ?? "";
  return timingSafeEqual(digest(given), digest(verifyToken)) ? challenge : null;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const arrayOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const isTracked = (value: unknown): value is DeliveryStatusName =>
  (DELIVERY_STATUSES as readonly unknown[]).includes(value);

function errorOf(status: Record<string, unknown>) {
  const [first] = arrayOf(status.errors);
  if (!isObject(first)) return "Meta reported the message as failed";
  const title = typeof first.title === "string" ? first.title : "no detail";
  return `Meta ${String(first.code ?? "error")}: ${title}`.slice(0, MAX_ERROR_LENGTH);
}

/**
 * Every tracked status in a callback, in the order Meta listed them. A callback
 * is `entry[].changes[]` with `field: "messages"`, whose `value.statuses[]`
 * carry `id` (the message id the send got back) and `status`. Anything else
 * (inbound messages, other fields, malformed entries) is skipped.
 */
export function deliveryStatuses(callback: unknown): DeliveryStatus[] {
  if (!isObject(callback)) return [];
  const found: DeliveryStatus[] = [];
  for (const entry of arrayOf(callback.entry)) {
    if (!isObject(entry)) continue;
    for (const change of arrayOf(entry.changes)) {
      if (!isObject(change) || change.field !== "messages" || !isObject(change.value)) continue;
      for (const status of arrayOf(change.value.statuses)) {
        if (!isObject(status) || typeof status.id !== "string" || status.id === "" || !isTracked(status.status)) continue;
        found.push({
          providerMessageId: status.id,
          status: status.status,
          ...(status.status === "failed" ? { error: errorOf(status) } : {}),
        });
      }
    }
  }
  return found;
}
