import { BUILD_SAMPLE_TOKEN, publicMenuResponse } from "@/lib/public-menu";

/**
 * A table's QR code (spec 03). Until ordering arrives in phase 6 it shows the
 * same menu as the generic code, through the same code: how it takes an order
 * after that is still open (S-32). The token is the only tenant input, and the
 * URL carries neither the table's label nor the restaurant. Cached like
 * /m/{menuToken}, for the same reason, so it has the same generateStaticParams.
 */
export async function generateStaticParams() {
  return [{ qrToken: BUILD_SAMPLE_TOKEN }];
}

export async function GET(
  _request: Request,
  { params }: RouteContext<"/t/[qrToken]">,
) {
  return publicMenuResponse("table", (await params).qrToken);
}
