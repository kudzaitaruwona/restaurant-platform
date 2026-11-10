import { z } from "zod";

/**
 * Environment variables, validated with zod.
 *
 * Required: what the app needs to serve any request today (database, public
 * URL, photo storage). Required in production: sign-in, with its own login, and
 * the admin login, which development can do without (it has the dev bypass,
 * and prints emails to the console).
 * Optional: variables owned by later tickets (WhatsApp, Turnstile) and the
 * migration/system database URLs, which only scripts and specific routes load.
 * A later ticket that starts depending on one of them makes it required here.
 * One deliberate exception: DATABASE_URL_SYSTEM and CRON_SECRET belong to the
 * scheduled job (S-35) and stay optional, because the production check below
 * also runs on preview deployments, where a missing value would stop the whole
 * site booting. The job's route fails closed on its own: no secret, or no
 * login, and it refuses the call. WHATSAPP_PHONE_NUMBER_ID and
 * WHATSAPP_ACCESS_TOKEN are the same kind of exception (spec 05): without them
 * the job holds queued messages in production rather than the site not booting.
 *
 * An empty value (`KEY=` in a .env file) counts as unset.
 */

/**
 * The role the app connects as: NOSUPERUSER, NOBYPASSRLS and not the owner of
 * any table, so row-level security applies to it. Created by a migration; see
 * db/migrations and provisionAppRole.
 */
export const APP_DATABASE_ROLE = "app_tenant";

/**
 * The role the admin path connects as (S-28): the only one that can call the
 * platform_* functions or touch the admin_auth_* tables, and nothing else. RLS
 * applies to it too, and provisionAppRole holds it to the same rules.
 */
export const ADMIN_DATABASE_ROLE = "app_admin";

/**
 * The role staff sign-in connects as (S-28, S-30): the only one that can touch
 * the staff_auth_* tables or look an email up across tenants, and nothing else. A
 * magic link is only a row in staff_auth_verification, so app_tenant mustn't be
 * able to write one. RLS applies to it too, and provisionAppRole holds it to
 * the same rules.
 */
export const STAFF_AUTH_DATABASE_ROLE = "app_staff_auth";

/**
 * The role the scheduled job connects as (spec 01, S-28, S-35). Unlike the
 * others it has BYPASSRLS, because the job works across every tenant, so it is
 * granted only the columns the job touches, and provisionSystemRole holds it to
 * that: no superuser, no table of its own.
 */
export const SYSTEM_DATABASE_ROLE = "app_system";

const blankToUndefined = (value: unknown) => (value === "" ? undefined : value);

const text = () =>
  z.string({
    error: (issue) =>
      issue.input === undefined ? "is missing" : "must be a string",
  });

const postgresUrl = () =>
  text().refine((value) => /^postgres(ql)?:\/\/[^\s]+$/.test(value), {
    message: "must be a postgres:// or postgresql:// connection URL",
  });

const httpUrl = () =>
  text().refine((value) => URL.canParse(value) && /^https?:/.test(value), {
    message: "must be an http(s) URL",
  });

const required = <T extends z.ZodType>(schema: T) =>
  z.preprocess(blankToUndefined, schema);
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess(blankToUndefined, schema.optional());

const r2PublicBaseUrl = text()
  .refine((value) => URL.canParse(value) && value.startsWith("https://"), {
    message: "must be an https URL",
    abort: true,
  })
  .refine((value) => !new URL(value).hostname.endsWith(".r2.dev"), {
    message:
      "must be the bucket's custom domain, never an r2.dev URL (D-07)",
  })
  .transform((value) => value.replace(/\/+$/, ""));

const connectsAs = (role: string, purpose: string) =>
  postgresUrl().refine(
    (value) => URL.canParse(value) && new URL(value).username === role,
    { message: `must connect as ${role}, ${purpose}` },
  );

// Any other role could be exempt from RLS, and nothing would look wrong: every
// query would just quietly see every tenant.
const appDatabaseUrl = connectsAs(APP_DATABASE_ROLE, "the role RLS applies to");

// app_tenant here would put the admin path back in reach of tenant code.
const adminDatabaseUrl = connectsAs(
  ADMIN_DATABASE_ROLE,
  "the role only the admin path uses",
);

// app_tenant here would hand every tenant query the power to forge a sign-in.
const staffAuthDatabaseUrl = connectsAs(
  STAFF_AUTH_DATABASE_ROLE,
  "the role only staff sign-in uses",
);

// Any other role here would either see nothing (RLS) or far too much.
const systemDatabaseUrl = connectsAs(
  SYSTEM_DATABASE_ROLE,
  "the role only the scheduled job and the Meta webhook use",
);

const configShape = {
  // Postgres (Neon) through the WebSocket Pool driver (D-07). The app's role;
  // DATABASE_URL_UNPOOLED is the role that owns the tables, for migrations.
  DATABASE_URL: required(appDatabaseUrl),
  DATABASE_URL_UNPOOLED: optional(postgresUrl()),
  // The scheduled job's role (S-35), with BYPASSRLS. Only its route opens it.
  DATABASE_URL_SYSTEM: optional(systemDatabaseUrl),
  // The admin path's role (S-28). Only src/db/admin.ts opens it.
  DATABASE_URL_ADMIN: optional(adminDatabaseUrl),
  // Staff sign-in's role (S-28, S-30). Only src/db/staff-auth.ts opens it.
  DATABASE_URL_STAFF_AUTH: optional(staffAuthDatabaseUrl),
  // Local development and CI only: host:port/path of a Neon wsproxy in front
  // of a plain Postgres. Refused in production: setting it turns off TLS to the
  // database for the whole process (src/db/client.ts).
  NEON_WS_PROXY: optional(text()),

  // S-25: returns a seeded identity instead of a login. Refused in production.
  DEV_AUTH_BYPASS: optional(text()),

  // Staff and platform-admin sign-in (S-27). Signs the session cookies.
  AUTH_SECRET: optional(
    text().min(32, { error: "must be at least 32 characters" }),
  ),
  GOOGLE_CLIENT_ID: optional(text()),
  GOOGLE_CLIENT_SECRET: optional(text()),
  // Sends the magic links and sign-in codes (D-09, proposed).
  RESEND_API_KEY: optional(text()),
  EMAIL_FROM: optional(text()),

  NEXT_PUBLIC_APP_URL: required(httpUrl()),

  // Photo storage: Cloudflare R2 (spec 02, D-07).
  R2_ACCOUNT_ID: required(text()),
  R2_ACCESS_KEY_ID: required(text()),
  R2_SECRET_ACCESS_KEY: required(text()),
  R2_BUCKET: required(text()),
  R2_PUBLIC_BASE_URL: required(r2PublicBaseUrl),

  // WhatsApp Cloud API (spec 05). The sender's two keys stay optional even in
  // production, like the job's: without them the job holds queued messages as
  // pending and sends them once the keys are set (src/lib/whatsapp/sender.ts).
  WHATSAPP_PHONE_NUMBER_ID: optional(
    text().regex(/^[0-9]+$/, { message: "must be Meta's numeric phone number ID, not the phone number" }),
  ),
  WHATSAPP_ACCESS_TOKEN: optional(
    text().regex(/^\S+$/, { message: "must be the token alone, with no spaces or \"Bearer\"" }),
  ),
  // Meta's webhook (#48). Optional like the sender's keys; the webhook fails
  // closed without them: no secret, no status taken; no token, no subscription.
  WHATSAPP_APP_SECRET: optional(text()),
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: optional(text()),

  // Scheduled job route (spec 05).
  CRON_SECRET: optional(text()),

  // Bot check on the booking confirm step (spec 04).
  TURNSTILE_SECRET_KEY: optional(text()),
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: optional(text()),
};

const developmentOnlyKeys = ["DEV_AUTH_BYPASS", "NEON_WS_PROXY"] as const;

const productionOnlyKeys = [
  "DATABASE_URL_ADMIN",
  "DATABASE_URL_STAFF_AUTH",
  "AUTH_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "RESEND_API_KEY",
  "EMAIL_FROM",
] as const;

export const envSchema = z
  .object({
    ...configShape,
    // Set by the platform, not by us, so they stay out of .env.example.
    NODE_ENV: optional(text()),
    VERCEL_ENV: optional(text()),
  })
  .superRefine((env, context) => {
    if (env.NODE_ENV !== "production" && env.VERCEL_ENV !== "production") return;
    for (const key of developmentOnlyKeys) {
      if (env[key] === undefined) continue;
      context.addIssue({
        code: "custom",
        path: [key],
        message: "must not be set in production",
      });
    }
    for (const key of productionOnlyKeys) {
      if (env[key] !== undefined) continue;
      context.addIssue({
        code: "custom",
        path: [key],
        message: "is required in production",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/** Every variable we configure, required or optional. */
export const envKeys = Object.keys(configShape) as (keyof typeof configShape)[];

export class EnvValidationError extends Error {
  constructor(public readonly problems: string[]) {
    super(
      [
        "Invalid environment variables:",
        ...problems.map((problem) => `  - ${problem}`),
        "See .env.example for the full list.",
      ].join("\n"),
    );
    this.name = "EnvValidationError";
  }
}

/** Validates an environment source. Never echoes a value back, only names. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (result.success) return result.data;
  throw new EnvValidationError(
    result.error.issues.map(
      (issue) => `${issue.path.join(".")} ${issue.message}`,
    ),
  );
}

let cached: Env | undefined;

/** The validated process environment. Throws on first use if it is invalid. */
export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

/**
 * Whether DEV_AUTH_BYPASS is active. `next build` inlines NODE_ENV, so in a
 * production build this is false before the variable is even read: the bypass
 * can't be reached there, whatever the runtime environment says and whether or
 * not startup validation ran.
 */
export function devAuthBypassEnabled(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    getEnv().DEV_AUTH_BYPASS !== undefined
  );
}
