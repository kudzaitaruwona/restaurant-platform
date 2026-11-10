import { getSystemDb } from "@/db/system";
import { getEnv } from "@/lib/env";
import { applyDeliveryStatuses } from "@/lib/whatsapp/delivery-status";
import { deliveryStatuses, isSignedByMeta, verificationChallenge } from "@/lib/whatsapp/webhook";

/**
 * Meta's WhatsApp webhook (spec 05, Delivery status; README "Turning on
 * WhatsApp"). The callback URL set in Meta's dashboard.
 *
 * GET is Meta's subscription handshake: the challenge comes back only when
 * `hub.verify_token` matches WHATSAPP_WEBHOOK_VERIFY_TOKEN.
 *
 * POST carries delivery statuses. It is Meta's only if `X-Hub-Signature-256`
 * is the HMAC-SHA256 of the raw body under WHATSAPP_APP_SECRET; anything else,
 * and everything while the secret is unset, is a 401 before the body is read as
 * JSON or the system login opened. Meta retries a callback that doesn't get a
 * 200, so one refused before the secret was set arrives again after.
 *
 * Besides the scheduled job's route, the only route that opens the system login
 * (DATABASE_URL_SYSTEM, BYPASSRLS; spec 01, S-28). Nothing in the request
 * chooses a restaurant: each status names a message id, and its row's own
 * restaurant_id keys the write. The proxy lets it through its cross-site check:
 * a server-to-server call with no session to abuse (src/proxy.ts).
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const challenge = verificationChallenge(params, getEnv().WHATSAPP_WEBHOOK_VERIFY_TOKEN);
  if (challenge === null) return new Response(null, { status: 403 });
  return new Response(challenge, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" },
  });
}

export async function POST(request: Request) {
  const rawBody = new Uint8Array(await request.arrayBuffer());
  if (!isSignedByMeta(rawBody, request.headers.get("x-hub-signature-256"), getEnv().WHATSAPP_APP_SECRET)) {
    return new Response(null, { status: 401 });
  }

  let callback: unknown;
  try {
    callback = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return new Response(null, { status: 400 });
  }

  const statuses = deliveryStatuses(callback);
  if (statuses.length === 0) return new Response(null, { status: 200 });
  try {
    await applyDeliveryStatuses(getSystemDb(), statuses);
  } catch (error) {
    // A Drizzle error's message quotes the statement's parameters.
    console.error(`WhatsApp webhook: writing delivery statuses failed: ${error instanceof Error ? error.name : "unknown"}`);
    return new Response(null, { status: 500 });
  }
  return new Response(null, { status: 200 });
}
