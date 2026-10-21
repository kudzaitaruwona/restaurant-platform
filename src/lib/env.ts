import { z } from "zod";

/**
 * Environment variables, validated with zod.
 *
 * Required: what the app needs to serve any request today (database, public
 * URL, photo storage). Optional: variables owned by later tickets (auth,
 * WhatsApp, Turnstile, the scheduled job) and the migration/system database
 * URLs, which only scripts and specific routes load. A later ticket that
 * starts depending on one of them makes it required here.
 *
 * An empty value (`KEY=` in a .env file) counts as unset.
 */

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

export const envSchema = z.object({
  // Postgres (Neon) through the WebSocket Pool driver (D-07).
  DATABASE_URL: required(postgresUrl()),
  DATABASE_URL_UNPOOLED: optional(postgresUrl()),
  DATABASE_URL_SYSTEM: optional(postgresUrl()),
  // Local development and CI only: host:port/path of a Neon wsproxy in front
  // of a plain Postgres. Unset in production (Neon serves WebSockets itself).
  NEON_WS_PROXY: optional(text()),

  // S-25: the tenant seam ticket adds the production refusal.
  DEV_AUTH_BYPASS: optional(text()),

  // Staff auth (Better Auth, implemented last per S-25).
  AUTH_SECRET: optional(text()),
  GOOGLE_CLIENT_ID: optional(text()),
  GOOGLE_CLIENT_SECRET: optional(text()),

  NEXT_PUBLIC_APP_URL: required(httpUrl()),

  // Photo storage: Cloudflare R2 (spec 02, D-07).
  R2_ACCOUNT_ID: required(text()),
  R2_ACCESS_KEY_ID: required(text()),
  R2_SECRET_ACCESS_KEY: required(text()),
  R2_BUCKET: required(text()),
  R2_PUBLIC_BASE_URL: required(r2PublicBaseUrl),

  // WhatsApp Cloud API (spec 05).
  WHATSAPP_PHONE_NUMBER_ID: optional(text()),
  WHATSAPP_ACCESS_TOKEN: optional(text()),
  WHATSAPP_APP_SECRET: optional(text()),
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: optional(text()),

  // Scheduled job route (spec 05).
  CRON_SECRET: optional(text()),

  // Bot check on the booking confirm step (spec 04).
  TURNSTILE_SECRET_KEY: optional(text()),
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: optional(text()),
});

export type Env = z.infer<typeof envSchema>;

/** Every variable the schema knows about, required or optional. */
export const envKeys = Object.keys(envSchema.shape) as (keyof Env)[];

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
