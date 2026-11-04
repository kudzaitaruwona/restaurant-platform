import { BUILD_SAMPLE_TOKEN, publicMenuResponse } from "@/lib/public-menu";

/**
 * The generic QR code's menu page (spec 02). A Route Handler rather than a page
 * so that it ships no JavaScript and answers an unknown token with a real 404
 * (S-32). generateStaticParams is what makes a visit to any other token cache
 * like a prerendered page: without it this would run on every request.
 */
export async function generateStaticParams() {
  return [{ menuToken: BUILD_SAMPLE_TOKEN }];
}

export async function GET(
  _request: Request,
  { params }: RouteContext<"/m/[menuToken]">,
) {
  return publicMenuResponse("menu", (await params).menuToken);
}
