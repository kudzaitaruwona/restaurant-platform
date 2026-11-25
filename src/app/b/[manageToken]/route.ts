import { cancelBooking, getManagedBooking } from "@/lib/bookings";
import { bookingResponse, confirmCancelResponse, notFoundResponse } from "@/lib/manage-page";
import { resolvePublicToken } from "@/lib/tenant/public";

/**
 * A guest's manage link (spec 04). The token is the only tenant input, and a
 * bearer secret, so the responses are never cached and never reach another site
 * in a Referer (src/lib/manage-page.ts).
 *
 * A Route Handler, not an App Router page, for the reasons S-32 gives the menu,
 * and one more: a page answers an unknown token with a 200 on this build, and this
 * route has to answer a real 404 and set its own headers.
 *
 * GET only reads. Cancelling is a POST, so a link preview or a prefetch that
 * opens the link can't cancel a booking. The page's Cancel is a link to
 * `?cancel=1`, a confirm page whose form is that POST, so it asks without script.
 */
export async function GET(request: Request, { params }: RouteContext<"/b/[manageToken]">) {
  const { manageToken } = await params;
  const tenant = await resolvePublicToken("manage", manageToken);
  if (!tenant) return notFoundResponse();

  const booking = await getManagedBooking(tenant, manageToken);
  if (!booking) return notFoundResponse();
  // ?cancel=1 is the confirm step before the POST; it too only reads (#104).
  return new URL(request.url).searchParams.has("cancel")
    ? confirmCancelResponse(manageToken, booking)
    : bookingResponse(manageToken, booking);
}

export async function POST(_request: Request, { params }: RouteContext<"/b/[manageToken]">) {
  const { manageToken } = await params;
  const tenant = await resolvePublicToken("manage", manageToken);
  if (!tenant) return notFoundResponse();

  // Nothing in the request but the token: the instant is the database's.
  const result = await cancelBooking(tenant, manageToken);
  return result.outcome === "not_found"
    ? notFoundResponse()
    : bookingResponse(manageToken, result.booking, result.outcome);
}
