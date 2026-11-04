import {
  botCheckMessage,
  closedMessage,
  confirmBooking,
  dateMessage,
  largePartyMessage,
  leadTimeMessage,
  parseGuestRequest,
  phoneLimitMessage,
  raceLostMessage,
} from "@/lib/bookings";
import { passesBotCheck, TURNSTILE_FIELD } from "@/lib/bot-check";
import {
  clientIp,
  declaredLength,
  ipBucket,
  limitKey,
  MAX_BODY_BYTES,
  readFormWithin,
} from "@/lib/booking-limits";
import { resolvePublicToken } from "@/lib/tenant/public";
import { spendSubmission } from "@/lib/tenant/public-limits";

const refuse = (error: string, status: number, headers?: HeadersInit) =>
  Response.json({ error }, { status, headers });

/**
 * A guest's confirm (spec 04). The slug is the only tenant input: nothing else in
 * the request can name a restaurant. This is a public write with no session, so
 * what it costs to ask is bounded before anything is spent on the answer, in this
 * order: the size the request declares, the rate limit, and only then the body,
 * the restaurant and the bot check.
 */
export async function POST(request: Request, { params }: RouteContext<"/api/r/[slug]/book">) {
  const length = declaredLength(request.headers);
  if (length === "invalid") return refuse("That request wasn't valid.", 400);
  if (length !== undefined && length > MAX_BODY_BYTES) {
    return refuse("That request was too large.", 413);
  }

  // From process.env as it is now, not the cached, validated copy: a blank value
  // counts as unset, as there, and these three decide how much to trust the request.
  const env = (name: string) => process.env[name] || undefined;
  const production = env("NODE_ENV") === "production";
  const ip = clientIp(request.headers, { onVercel: env("VERCEL_ENV") !== undefined, production });
  // With no address: development and tests aren't throttled, since nothing there
  // says who is asking. In production everyone without one shares a single count,
  // so the limit can't be walked around by hiding the address (proposed).
  if (ip !== undefined || production) {
    const spent = await spendSubmission(
      limitKey(ip && ipBucket(ip), env("AUTH_SECRET")),
    );
    if (!spent.allowed) {
      return refuse(
        "Too many booking attempts. Wait a few minutes, then try again.",
        429,
        { "Retry-After": String(spent.retryAfterSeconds) },
      );
    }
  }

  const tenant = await resolvePublicToken("slug", (await params).slug);
  if (!tenant) return refuse("Restaurant not found.", 404);

  const form = await readFormWithin(request);
  if (form === "too_large") return refuse("That request was too large.", 413);
  const parsed = parseGuestRequest(form);
  if (!parsed.success) return refuse(parsed.message, 400);

  const token = form.get(TURNSTILE_FIELD);
  const human = await passesBotCheck(
    { token: typeof token === "string" ? token : undefined, ip },
    { secret: env("TURNSTILE_SECRET_KEY"), production },
  );
  if (!human) return refuse(botCheckMessage, 403);

  const result = await confirmBooking(tenant, parsed.data);
  switch (result.outcome) {
    case "confirmed":
      return Response.json({ confirmation: result.confirmation }, { status: 201 });
    case "race_lost":
      return Response.json({ error: raceLostMessage, times: result.times }, { status: 409 });
    case "lead_time":
      return Response.json({ error: leadTimeMessage, times: result.times }, { status: 409 });
    case "phone_limit":
      return refuse(phoneLimitMessage(result.held), 409);
    case "date_unavailable":
      return refuse(dateMessage, 409);
    case "party_too_large":
      return Response.json(
        {
          error: largePartyMessage(result.threshold),
          contactPhone: result.contactPhone,
          whatsappLink: result.whatsappLink,
        },
        { status: 409 },
      );
    case "closed":
      return refuse(closedMessage, 409);
  }
}
