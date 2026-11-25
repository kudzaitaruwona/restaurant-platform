import {
  alreadyBookedMessage,
  botCheckMessage,
  closedMessage,
  confirmBooking,
  type ConfirmOutcome,
  dateMessage,
  findEarlierBooking,
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
 * The answer to a retry of a submission that has already booked (#134), though
 * something now refuses to let it book: it wouldn't, so it isn't refused. Costs a
 * request with no id of its own nothing but its parsing.
 */
async function answerToRetry(request: Request, slug: string) {
  const form = await readFormWithin(request);
  if (form === "too_large") return undefined;
  const parsed = parseGuestRequest(form);
  if (!parsed.success || !parsed.data.request) return undefined;
  const tenant = await resolvePublicToken("slug", slug);
  const earlier = tenant && (await findEarlierBooking(tenant, parsed.data));
  return earlier && answer(earlier);
}

/**
 * A guest's confirm (spec 04). The slug is the only tenant input: nothing else in
 * the request can name a restaurant. This is a public write with no session, so
 * what it costs to ask is bounded before anything is spent on the answer, in this
 * order: the size the request declares, the rate limit, and only then the body,
 * the restaurant and the bot check. A retry of a booking already made passes the rate
 * limit and the bot check, and isn't counted again: it books nothing (#134).
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
  const { slug } = await params;
  const ip = clientIp(request.headers, { onVercel: env("VERCEL_ENV") !== undefined, production });
  // With no address: development and tests aren't throttled, since nothing there
  // says who is asking. In production everyone without one shares a single count,
  // so the limit can't be walked around by hiding the address (proposed).
  let giveBack = async () => {};
  if (ip !== undefined || production) {
    const spent = await spendSubmission(
      limitKey(ip && ipBucket(ip), env("AUTH_SECRET")),
    );
    if (spent.allowed) giveBack = spent.giveBack;
    else {
      const retried = await answerToRetry(request, slug);
      if (retried) return retried;
      // The restaurant hasn't been looked up, and isn't for this: the page that posted
      // knows its number and adds it (#103).
      return refuse(
        "Too many booking attempts. Wait a few minutes, then try again, or contact the restaurant.",
        429,
        { "Retry-After": String(spent.retryAfterSeconds) },
      );
    }
  }

  const tenant = await resolvePublicToken("slug", slug);
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
  const result = human
    ? await confirmBooking(tenant, parsed.data)
    : await findEarlierBooking(tenant, parsed.data);
  if (!result) return refuse(botCheckMessage, 403);
  if (result.outcome === "replayed" || result.outcome === "already_booked") await giveBack();
  return answer(result);
}

function answer(result: ConfirmOutcome) {
  switch (result.outcome) {
    case "confirmed":
    case "replayed":
      return Response.json({ confirmation: result.confirmation }, { status: 201 });
    case "already_booked":
      // No link to the booking: this isn't the submission that made it.
      return Response.json(
        {
          error: alreadyBookedMessage(result.booked),
          alreadyBooked: true,
          contactPhone: result.contactPhone,
          whatsappLink: result.whatsappLink,
        },
        { status: 409 },
      );
    case "race_lost":
      return Response.json(
        { error: raceLostMessage, times: result.times, available: result.available },
        { status: 409 },
      );
    case "lead_time":
      return Response.json(
        { error: leadTimeMessage, times: result.times, available: result.available },
        { status: 409 },
      );
    case "phone_limit":
      // No link to the bookings: whoever is asking has only typed a number (#89).
      return Response.json(
        {
          error: phoneLimitMessage(result.held),
          contactPhone: result.contactPhone,
          whatsappLink: result.whatsappLink,
        },
        { status: 409 },
      );
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
