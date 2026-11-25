import type { Audience } from "./index";

/**
 * Where sign-in goes back to (S-30 in detail). No imports with weight: the
 * signed-out page runs this in the browser.
 */

/** Where each session type lands with nowhere else to go. Each stays in its own area. */
export const signInDefaults: Record<Audience, string> = {
  staff: "/dashboard",
  admin: "/admin",
};

export const signInPages: Record<Audience, string> = {
  staff: "/login",
  admin: "/login/admin",
};

const MAX_LENGTH = 512;

/**
 * A list of what's allowed, so a trick nobody thought of is refused too. Path
 * segments hold no dots, escapes or backslashes, and none is empty, so there is
 * no second way to read one. A query holds no slash of any kind.
 */
const shapes: Record<Audience, RegExp> = {
  staff: /^\/dashboard(?:\/[A-Za-z0-9_-]+)*(?:\?[A-Za-z0-9._~=&:%+,-]*)?$/,
  admin: /^\/admin(?:\/[A-Za-z0-9_-]+)*(?:\?[A-Za-z0-9._~=&:%+,-]*)?$/,
};

/** Control characters, separators and a second layer of escaping, once decoded. */
const HIDDEN = /[\u0000-\u001f\u007f-\u009f/\\%]/;

/** The value if it's a page this session type may return to, else undefined. */
export function returnPath(value: unknown, audience: Audience): string | undefined {
  if (typeof value !== "string" || value.length > MAX_LENGTH) return undefined;
  if (!shapes[audience].test(value)) return undefined;
  try {
    if (HIDDEN.test(decodeURIComponent(value.split("?")[1] ?? ""))) return undefined;
  } catch {
    return undefined;
  }
  return value;
}

/** The sign-in page that comes back to `next`, which returnPath has passed. */
export const signInPageFor = (audience: Audience, next: string | undefined) =>
  next && next !== signInDefaults[audience]
    ? `${signInPages[audience]}?next=${encodeURIComponent(next)}`
    : signInPages[audience];

/** The sign-in link for someone signed out on a page: the admin's under /admin. */
export function signInHref(pathname: string | null, search: string) {
  const path = pathname ?? "";
  const audience: Audience = path === "/admin" || path.startsWith("/admin/") ? "admin" : "staff";
  const next =
    (search ? returnPath(`${path}?${search}`, audience) : undefined) ?? returnPath(path, audience);
  return signInPageFor(audience, next);
}

/**
 * Whether Better Auth may be handed this error page: the audience's own sign-in
 * page, with nothing but a place to return to.
 */
export function isSignInPage(value: unknown, audience: Audience) {
  if (typeof value !== "string") return false;
  const [page, query, ...rest] = value.split("?");
  if (page !== signInPages[audience] || rest.length > 0) return false;
  if (query === undefined) return true;
  const params = [...new URLSearchParams(query)];
  return (
    params.length === 1 &&
    params[0][0] === "next" &&
    value === `${page}?next=${encodeURIComponent(params[0][1])}` &&
    returnPath(params[0][1], audience) !== undefined
  );
}
