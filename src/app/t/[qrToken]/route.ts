import { BUILD_SAMPLE_TOKEN, publicMenuResponse } from "@/lib/public-menu";

/**
 * A table's QR code (spec 03), and the ordering entry point (spec 06). It shows
 * the same menu as the generic code, through the same code, plus Add buttons,
 * an order form and one small inline script (S-32). The page is cached like
 * /m/{menuToken}, for the same reason, so it has the same generateStaticParams,
 * and nothing about a session is ever written into it: the script's scan and
 * order go to uncached endpoints of their own under /api/t/{qrToken}/, because
 * src/proxy.ts keeps every method but GET and HEAD off this path. The token is
 * the only tenant input, and the URL carries neither the table's label nor the
 * restaurant.
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
