import { handleAuthRequest, type Audience } from "../../src/lib/auth";
import { codeIn, type installFakeServices } from "./fake-services";

/**
 * Drives the real sign-in endpoints the way a browser does, as handler calls.
 * The cookies that come back are real signed sessions.
 */
const origin = "http://localhost:3000";

export const authUrl = (audience: Audience, path: string) =>
  `${origin}/api/auth/${audience}${path}`;

export const postAuth = (
  audience: Audience,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  handleAuthRequest(
    audience,
    new Request(authUrl(audience, path), {
      method: "POST",
      headers: { "content-type": "application/json", origin, ...headers },
      body: JSON.stringify(body),
    }),
  );

export const getAuthUrl = (
  audience: Audience,
  url: string,
  headers: Record<string, string> = {},
) => handleAuthRequest(audience, new Request(url, { headers }));

/** `name=value` pairs from a response's Set-Cookie headers, without deleted ones. */
export const cookiesFrom = (response: Response) =>
  response.headers
    .getSetCookie()
    .filter((cookie) => !/max-age=0/i.test(cookie))
    .map((cookie) => cookie.split(";")[0])
    .join("; ");

/** Signs in with an emailed code and returns the Cookie header for the session. */
export async function signIn(
  services: ReturnType<typeof installFakeServices>,
  audience: Audience,
  email: string,
) {
  const sent = await postAuth(audience, "/email-otp/send-verification-otp", {
    email,
    type: "sign-in",
  });
  if (!sent.ok) throw new Error(`Couldn't request a code: ${sent.status}`);
  const otp = codeIn(await services.emailTo(email));
  const response = await postAuth(audience, "/sign-in/email-otp", { email, otp });
  if (!response.ok) throw new Error(`Couldn't sign in: ${response.status}`);
  return cookiesFrom(response);
}
