import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { emailOTP, magicLink } from "better-auth/plugins";
import { after } from "next/server";
import { getDb } from "@/db";
import {
  adminAuthAccount,
  adminAuthRateLimit,
  adminAuthSession,
  adminAuthUser,
  adminAuthVerification,
  staffAuthAccount,
  staffAuthRateLimit,
  staffAuthSession,
  staffAuthUser,
  staffAuthVerification,
} from "@/db/schema";
import { getEnv } from "@/lib/env";
import {
  clearCodeAttempts,
  SIGN_IN_CODES_PAUSED,
  spendCodeAttempt,
} from "./code-limit";
import {
  SESSION_MAX_AGE_SECONDS,
  secureCookies,
  sessionCookieName,
} from "./cookies";
import {
  consoleSender,
  resendSender,
  signInCodeEmail,
  signInLinkEmail,
  type Email,
  type EmailSender,
} from "./email";
import { findPlatformAdminId, findStaffIdentity } from "./identity";

/**
 * Sign-in (S-27, S-30). Two separate Better Auth instances, one per session type
 * (D-07): own cookie, own tables, own URLs. The only way in is an email that
 * already belongs to an active staff record or a platform admin.
 */
export type Audience = "staff" | "admin";

const schemas = {
  staff: {
    user: staffAuthUser,
    session: staffAuthSession,
    account: staffAuthAccount,
    verification: staffAuthVerification,
    rateLimit: staffAuthRateLimit,
  },
  admin: {
    user: adminAuthUser,
    session: adminAuthSession,
    account: adminAuthAccount,
    verification: adminAuthVerification,
    rateLimit: adminAuthRateLimit,
  },
};

const signInPages: Record<Audience, string> = {
  staff: "/login",
  admin: "/login/admin",
};

const SIGN_IN_EXPIRY_MINUTES = 10;
const signInExpirySeconds = SIGN_IN_EXPIRY_MINUTES * 60;

const SEND_CODE_PATH = "/email-otp/send-verification-otp";
const USE_CODE_PATH = "/sign-in/email-otp";

export const basePath = (audience: Audience) => `/api/auth/${audience}`;

const mayUseSignIn = async (audience: Audience, email: string) =>
  (audience === "staff"
    ? await findStaffIdentity(email)
    : await findPlatformAdminId(email)) !== undefined;

function emailSender(): EmailSender {
  const { RESEND_API_KEY, EMAIL_FROM } = getEnv();
  if (RESEND_API_KEY && EMAIL_FROM) {
    return resendSender(RESEND_API_KEY, EMAIL_FROM);
  }
  return consoleSender;
}

function createAuth(audience: Audience) {
  const env = getEnv();
  if (!env.AUTH_SECRET) {
    throw new Error("AUTH_SECRET is missing, so nobody can sign in.");
  }
  const sender = emailSender();

  /**
   * Sends only to someone who may sign in, and answers everyone the same way,
   * so the sign-in form can't be used to find out who works where. Runs after
   * the response for the same reason: a provider call would be a timing tell.
   */
  async function deliver(email: string, compose: () => Email) {
    if (await mayUseSignIn(audience, email)) await sender.send(compose());
  }

  /** The one gate every way in passes through. Refusals name no reason. */
  async function refuseUnlessAllowed(email: string, verified: boolean) {
    if (verified && (await mayUseSignIn(audience, email))) return;
    throw new APIError("FORBIDDEN", {
      code: "sign_in_refused",
      message: "This email can't sign in here.",
    });
  }

  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = env;

  return betterAuth({
    appName: "restaurant-platform",
    baseURL: env.NEXT_PUBLIC_APP_URL,
    basePath: basePath(audience),
    secret: env.AUTH_SECRET,
    database: drizzleAdapter(getDb(), {
      provider: "pg",
      schema: schemas[audience],
    }),
    telemetry: { enabled: false },
    session: {
      // Idle expiry: each use pushes it out, at most once a day. See src/proxy.ts
      // for the cookie's half of this.
      expiresIn: SESSION_MAX_AGE_SECONDS,
      updateAge: 24 * 60 * 60,
    },
    // In the database because memory would be per-instance on Vercel. Tests and
    // development sign in far faster than anyone should.
    rateLimit: {
      enabled: process.env.NODE_ENV === "production",
      storage: "database",
    },
    // The ceiling on codes, per email (S-30). Everyone is counted the same,
    // known or not, so being refused says nothing about who works where. A
    // malformed body goes on to fail Better Auth's own validation.
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== SEND_CODE_PATH && ctx.path !== USE_CODE_PATH) return;
        const email: unknown = ctx.body?.email;
        if (typeof email !== "string") return;
        if (await spendCodeAttempt(audience, email.toLowerCase())) return;
        throw new APIError("TOO_MANY_REQUESTS", {
          code: SIGN_IN_CODES_PAUSED,
          message: "Too many sign-in codes for this email.",
        });
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== USE_CODE_PATH || !ctx.context.newSession) return;
        const { email } = ctx.context.newSession.user;
        await clearCodeAttempts(audience, email.toLowerCase());
      }),
    },
    account: {
      // Google only tells us who someone is. We never call it for them, so its
      // tokens would be credentials kept for nothing.
      updateAccountOnSignIn: false,
    },
    advanced: {
      cookiePrefix: audience,
      useSecureCookies: secureCookies(),
      // Off by default under test, and we want the tests to see it.
      disableOriginCheck: false,
      backgroundTasks: { handler: (task) => after(task) },
      // It would insist on the password and OAuth token columns we left out on
      // purpose (S-27). The integration tests sign in for real instead.
      database: { validateSchema: false },
    },
    onAPIError: {
      errorURL: new URL(signInPages[audience], env.NEXT_PUBLIC_APP_URL).toString(),
    },
    socialProviders:
      GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: GOOGLE_CLIENT_ID,
              clientSecret: GOOGLE_CLIENT_SECRET,
              prompt: "select_account",
              disableIdTokenSignIn: true,
            },
          }
        : undefined,
    plugins: [
      magicLink({
        expiresIn: signInExpirySeconds,
        storeToken: "hashed",
        sendMagicLink: async ({ email, url }, context) => {
          const delivery = deliver(email, () =>
            signInLinkEmail(email, url, SIGN_IN_EXPIRY_MINUTES),
          );
          await context?.context.runInBackgroundOrAwait(delivery);
        },
      }),
      emailOTP({
        expiresIn: signInExpirySeconds,
        storeOTP: "hashed",
        allowedAttempts: 3,
        sendVerificationOTP: async ({ email, otp, type }) => {
          if (type !== "sign-in") return;
          await deliver(email, () =>
            signInCodeEmail(email, otp, SIGN_IN_EXPIRY_MINUTES),
          );
        },
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            await refuseUnlessAllowed(user.email, user.emailVerified);
          },
        },
      },
      session: {
        create: {
          before: async (session, context) => {
            const user = await context?.context.internalAdapter.findUserById(
              session.userId,
            );
            await refuseUnlessAllowed(user?.email ?? "", !!user?.emailVerified);
          },
        },
      },
      account: {
        create: {
          before: async (account) => ({
            data: {
              ...account,
              accessToken: undefined,
              refreshToken: undefined,
              idToken: undefined,
              accessTokenExpiresAt: undefined,
              refreshTokenExpiresAt: undefined,
            },
          }),
        },
      },
    },
  });
}

const instances: Partial<Record<Audience, ReturnType<typeof createAuth>>> = {};

/** Built on first use: `next build` has no secrets, and importing needs none. */
function getAuth(audience: Audience) {
  return (instances[audience] ??= createAuth(audience));
}

/**
 * Everything sign-in uses, and nothing else. Better Auth ships far more (email
 * and password, password reset, account linking), and a list of what's allowed
 * can't go stale the way a list of what's forbidden does.
 */
const signInPaths = new Set([
  "/sign-in/magic-link",
  "/magic-link/verify",
  "/email-otp/send-verification-otp",
  "/sign-in/email-otp",
  "/sign-in/social",
  "/callback/google",
  "/sign-out",
]);

export function handleAuthRequest(audience: Audience, request: Request) {
  const path = new URL(request.url).pathname.slice(basePath(audience).length);
  if (!signInPaths.has(path)) return new Response(null, { status: 404 });
  return getAuth(audience).handler(request);
}

/** The email of whoever this request's session belongs to, if anyone's. */
export async function sessionEmail(audience: Audience, requestHeaders: Headers) {
  // Most anonymous requests stop here, with no database call.
  const cookie = requestHeaders.get("cookie") ?? "";
  if (!cookie.includes(sessionCookieName(audience))) return undefined;

  const session = await getAuth(audience).api.getSession({
    headers: requestHeaders,
  });
  return session?.user.email;
}
