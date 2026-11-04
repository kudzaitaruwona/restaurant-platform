import "server-only";

/**
 * The bot check on the confirm step: Cloudflare Turnstile, invisible (spec 04,
 * abuse controls, proposed). The widget on the page gives the guest's browser a
 * token; it comes to the server in the form, and only the server, holding the
 * secret, asks Cloudflare whether it is good. The token goes nowhere else and is
 * never logged.
 */

export const TURNSTILE_FIELD = "cf-turnstile-response";
/** Cloudflare's own limit on a token's length: anything longer isn't one. */
const MAX_TOKEN_LENGTH = 2048;
const SITE_VERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TIMEOUT_MS = 3_000;

/**
 * What Cloudflare said, or that it couldn't be asked. "misconfigured" is Cloudflare
 * refusing our secret: that is our fault, not the guest's.
 */
export type Verdict = "valid" | "invalid" | "unavailable" | "misconfigured";

/** The seam: the only code that talks to Cloudflare. Tests put a fake here. */
export type SiteVerify = (input: { secret: string; token: string; ip?: string }) => Promise<Verdict>;

export const verifyWithCloudflare: SiteVerify = async ({ secret, token, ip }) => {
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (ip) body.set("remoteip", ip);
    const response = await fetch(SITE_VERIFY, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return "unavailable";
    const answer: { success?: unknown; "error-codes"?: unknown } = await response.json();
    if (answer.success === true) return "valid";
    const codes = Array.isArray(answer["error-codes"]) ? answer["error-codes"] : [];
    if (codes.includes("missing-input-secret") || codes.includes("invalid-input-secret")) {
      return "misconfigured";
    }
    if (codes.includes("internal-error")) return "unavailable";
    return "invalid";
  } catch {
    // Timeout, no network, not JSON. Not logged with the error: it could quote the request.
    return "unavailable";
  }
};

/**
 * Whether the confirm may go on *(proposed)*.
 *
 * - A secret is set and Cloudflare says the token is good: yes. Says it isn't, or
 *   there is no token: no.
 * - No secret, or Cloudflare refusing ours: development and tests carry stand-in
 *   or blank keys, so they go on; production does not (fail closed), because
 *   booking with the check silently off is the thing it is there to prevent. The
 *   cost is that a production deploy without the key takes no bookings until it is
 *   set, which is loud, and previews need Cloudflare's published test key.
 * - Cloudflare can't be reached, or errors: go on (fail open), in every
 *   environment. An outage shouldn't stop a restaurant taking bookings, nobody
 *   can make Cloudflare fail for another guest, and the rate limit and the
 *   per-phone limit still stand in front of the seats.
 */
export async function passesBotCheck(
  input: { token: string | undefined; ip: string | undefined },
  settings: { secret: string | undefined; production: boolean },
  verify: SiteVerify = verifyWithCloudflare,
) {
  const { secret, production } = settings;
  if (!secret) return reportMissingSecret(production);
  const { token } = input;
  if (!token || token.length > MAX_TOKEN_LENGTH) return false;
  const verdict = await verify({ secret, token, ip: input.ip });
  switch (verdict) {
    case "valid":
      return true;
    case "invalid":
      return false;
    case "unavailable":
      console.warn("Turnstile couldn't be reached; letting the booking through.");
      return true;
    case "misconfigured":
      return reportMissingSecret(production);
  }
}

function reportMissingSecret(production: boolean) {
  if (production) console.error("TURNSTILE_SECRET_KEY is missing or refused; refusing bookings.");
  return !production;
}
