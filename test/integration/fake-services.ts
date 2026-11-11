import { vi } from "vitest";

/**
 * Fakes for the two services sign-in talks to: Resend and Google. They sit at
 * the network boundary, so everything of ours and of Better Auth's runs for
 * real and only the HTTP call out of the process is answered here.
 */
export type SentEmail = { from: string; to: string[]; subject: string; text: string };

export type GoogleProfile = {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
};

const fakeJwt = (claims: Record<string, unknown>) =>
  [{ alg: "RS256", kid: "fake" }, claims]
    .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
    .concat("fake-signature")
    .join(".");

export function installFakeServices() {
  const sent: SentEmail[] = [];
  const google: { profile?: GoogleProfile } = {};
  /** Resend refuses any email to these addresses, as it would a bounced one. */
  const refusing = new Set<string>();

  vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
  vi.stubEnv("AUTH_SECRET", "integration-test-secret-of-32-characters-or-more");
  vi.stubEnv("RESEND_API_KEY", "re_fake");
  vi.stubEnv("EMAIL_FROM", "Sign-in <sign-in@example.test>");
  vi.stubEnv("GOOGLE_CLIENT_ID", "fake-client-id");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "fake-client-secret");

  const realFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === "https://api.resend.com/emails") {
        const email: SentEmail = JSON.parse(String(init?.body));
        if (email.to.some((to) => refusing.has(to))) {
          return Response.json({ message: "Refused" }, { status: 422 });
        }
        sent.push(email);
        return Response.json({ id: "fake" });
      }
      if (url === "https://oauth2.googleapis.com/token") {
        return Response.json({
          access_token: "fake-google-access-token",
          id_token: fakeJwt({ ...google.profile, iss: "https://accounts.google.com" }),
          expires_in: 3600,
          token_type: "Bearer",
        });
      }
      if (url.includes("google")) throw new Error(`Unexpected call to ${url}`);
      return realFetch(input, init);
    },
  );

  /** The next email to arrive for this address, taken off the pile. */
  async function emailTo(address: string) {
    return vi.waitFor(() => {
      const index = sent.findIndex((email) => email.to.includes(address));
      if (index < 0) throw new Error(`No email to ${address}`);
      return sent.splice(index, 1)[0];
    });
  }

  return { sent, google, refusing, emailTo };
}

export const codeIn = (email: SentEmail) => {
  const code = /\b(\d{6})\b/.exec(email.text)?.[1];
  if (!code) throw new Error("No code in that email");
  return code;
};

export const linkIn = (email: SentEmail) => {
  const link = /https?:\/\/\S+/.exec(email.text)?.[0];
  if (!link) throw new Error("No link in that email");
  return link;
};
