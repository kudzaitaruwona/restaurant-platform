import { NextResponse, type NextRequest } from "next/server";
import {
  SESSION_MAX_AGE_SECONDS,
  secureCookies,
  sessionCookieName,
} from "@/lib/auth/cookies";

/**
 * Two things every staff request needs, kept off the public pages (spec 02's
 * budget) by the matcher, and holding no database work.
 *
 * Any new staff page outside these paths needs adding here, or its visits stop
 * counting towards keeping a session alive.
 */
export const config = {
  matcher: ["/dashboard/:path*", "/admin/:path*", "/api/:path*"],
};

const readMethods = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * SameSite=Lax already keeps the session cookie off cross-site posts. This also
 * covers what it doesn't: sibling subdomains count as same-site (S-28). A browser
 * always sends Origin on these requests, so a missing one is a server-to-server
 * caller with no cookie to abuse, like the Meta webhook.
 */
function isCrossSiteWrite(request: NextRequest) {
  if (readMethods.has(request.method)) return false;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  return URL.parse(origin)?.host !== host;
}

/**
 * Sessions expire 30 days after last use. Better Auth moves the expiry in the
 * database as it reads the session, but it can't reach the browser from a page,
 * where cookies are read-only, so this does: the same value with a fresh expiry.
 * It proves nothing about the session, which is still checked on every request.
 */
function keepSessionCookiesAlive(request: NextRequest, response: NextResponse) {
  for (const audience of ["staff", "admin"] as const) {
    const name = sessionCookieName(audience);
    const cookie = request.cookies.get(name);
    if (!cookie) continue;
    response.cookies.set(name, cookie.value, {
      httpOnly: true,
      secure: secureCookies(),
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
  }
}

export function proxy(request: NextRequest) {
  if (isCrossSiteWrite(request)) {
    return new NextResponse(null, { status: 403 });
  }

  const response = NextResponse.next();
  // Better Auth's own routes set and delete these cookies themselves.
  if (!request.nextUrl.pathname.startsWith("/api/auth/")) {
    keepSessionCookiesAlive(request, response);
  }
  return response;
}
