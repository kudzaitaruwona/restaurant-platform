import type { Audience } from "./index";

/** No imports with weight: src/proxy.ts runs this ahead of every staff page. */
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** Local `next dev` is plain http, and a browser may drop a Secure cookie there. */
export const secureCookies = () => process.env.NODE_ENV === "production";

/** Better Auth adds the prefix itself when told to use secure cookies. */
export const sessionCookieName = (audience: Audience) =>
  `${secureCookies() ? "__Secure-" : ""}${audience}.session_token`;
