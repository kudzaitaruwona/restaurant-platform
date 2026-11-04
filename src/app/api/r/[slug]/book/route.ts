import {
  closedMessage,
  confirmBooking,
  parseGuestRequest,
  raceLostMessage,
} from "@/lib/bookings";
import { resolvePublicToken } from "@/lib/tenant/public";

/**
 * A guest's confirm (spec 04). The slug is the only tenant input: nothing else in
 * the request can name a restaurant. This is the seam for #33's rate limit and
 * bot check, which run before anything else here.
 */
export async function POST(request: Request, { params }: RouteContext<"/api/r/[slug]/book">) {
  const tenant = await resolvePublicToken("slug", (await params).slug);
  if (!tenant) return Response.json({ error: "Restaurant not found." }, { status: 404 });

  const form = await request.formData().catch(() => new FormData());
  const parsed = parseGuestRequest(form);
  if (!parsed.success) return Response.json({ error: parsed.message }, { status: 400 });

  const result = await confirmBooking(tenant, parsed.data);
  switch (result.outcome) {
    case "confirmed":
      return Response.json({ confirmation: result.confirmation }, { status: 201 });
    case "race_lost":
      return Response.json({ error: raceLostMessage, times: result.times }, { status: 409 });
    case "closed":
      return Response.json({ error: closedMessage }, { status: 409 });
  }
}
