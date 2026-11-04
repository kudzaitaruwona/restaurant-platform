import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvValidationError, parseEnv } from "./env";

const valid = {
  DATABASE_URL: "postgres://app_tenant:app_tenant@localhost:5499/restaurant_dev",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  R2_ACCOUNT_ID: "account",
  R2_ACCESS_KEY_ID: "key",
  R2_SECRET_ACCESS_KEY: "secret",
  R2_BUCKET: "photos",
  R2_PUBLIC_BASE_URL: "https://images.example.test",
};

// Sign-in has to work in production, so production can't start without these.
const auth = {
  AUTH_SECRET: "a-secret-of-at-least-thirty-two-characters",
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  RESEND_API_KEY: "re_key",
  EMAIL_FROM: "Sign-in <sign-in@example.test>",
};

function errorFrom(source: Record<string, string | undefined>) {
  try {
    parseEnv(source);
  } catch (error) {
    return error as EnvValidationError;
  }
  throw new Error("expected parseEnv to throw");
}

describe("parseEnv", () => {
  it("accepts a complete environment", () => {
    const env = parseEnv(valid);
    expect(env.DATABASE_URL).toBe(valid.DATABASE_URL);
    expect(env.R2_PUBLIC_BASE_URL).toBe("https://images.example.test");
  });

  it("fails with a message naming a missing required variable", () => {
    const error = errorFrom({ ...valid, DATABASE_URL: undefined });
    expect(error).toBeInstanceOf(EnvValidationError);
    expect(error.message).toMatch(/DATABASE_URL/);
    expect(error.message).toMatch(/missing/i);
  });

  it("treats an empty value (KEY= in a .env file) as missing", () => {
    const error = errorFrom({ ...valid, R2_BUCKET: "" });
    expect(error.message).toMatch(/R2_BUCKET/);
  });

  it("reports every problem at once, not just the first", () => {
    const error = errorFrom({
      ...valid,
      DATABASE_URL: undefined,
      NEXT_PUBLIC_APP_URL: "not a url",
    });
    expect(error.message).toMatch(/DATABASE_URL/);
    expect(error.message).toMatch(/NEXT_PUBLIC_APP_URL/);
  });

  it("rejects a database URL that is not a Postgres URL", () => {
    const error = errorFrom({ ...valid, DATABASE_URL: "mysql://x@y/z" });
    expect(error.message).toMatch(/DATABASE_URL/);
  });

  it("rejects an r2.dev public URL: photos must be served from a custom domain", () => {
    const error = errorFrom({
      ...valid,
      R2_PUBLIC_BASE_URL: "https://pub-abc123.r2.dev",
    });
    expect(error.message).toMatch(/R2_PUBLIC_BASE_URL/);
    expect(error.message).toMatch(/r2\.dev/);
  });

  it("rejects a non-https public photo URL", () => {
    const error = errorFrom({
      ...valid,
      R2_PUBLIC_BASE_URL: "http://images.example.test",
    });
    expect(error.message).toMatch(/R2_PUBLIC_BASE_URL/);
  });

  it("strips a trailing slash from the public photo URL", () => {
    const env = parseEnv({
      ...valid,
      R2_PUBLIC_BASE_URL: "https://images.example.test/",
    });
    expect(env.R2_PUBLIC_BASE_URL).toBe("https://images.example.test");
  });

  it("leaves variables owned by later tickets optional", () => {
    const env = parseEnv({
      ...valid,
      AUTH_SECRET: "",
      WHATSAPP_ACCESS_TOKEN: "",
      CRON_SECRET: undefined,
    });
    expect(env.AUTH_SECRET).toBeUndefined();
    expect(env.WHATSAPP_ACCESS_TOKEN).toBeUndefined();
    expect(env.CRON_SECRET).toBeUndefined();
  });

  it("validates an optional variable when it is set", () => {
    const error = errorFrom({ ...valid, DATABASE_URL_SYSTEM: "nonsense" });
    expect(error.message).toMatch(/DATABASE_URL_SYSTEM/);
  });

  it("never echoes secret values in the error message", () => {
    const error = errorFrom({
      ...valid,
      DATABASE_URL: "mysql://user:hunter2@host/db",
    });
    expect(error.message).not.toMatch(/hunter2/);
  });

  it("rejects an app connection that isn't the RLS-bound role: any other role could skip tenant isolation", () => {
    const error = errorFrom({
      ...valid,
      DATABASE_URL: "postgres://neondb_owner:secret@host/db",
    });
    expect(error.message).toMatch(/DATABASE_URL must connect as app_tenant/);
    expect(error.message).not.toMatch(/secret/);
  });

  describe.each([
    ["NODE_ENV=production", { NODE_ENV: "production" }],
    ["VERCEL_ENV=production", { VERCEL_ENV: "production" }],
  ])("with %s", (_name, production) => {
    it("refuses DEV_AUTH_BYPASS (S-25)", () => {
      const error = errorFrom({ ...valid, ...auth, ...production, DEV_AUTH_BYPASS: "1" });
      expect(error.message).toMatch(/DEV_AUTH_BYPASS must not be set in production/);
    });

    it("refuses DEV_AUTH_BYPASS whatever its value: set is set", () => {
      const error = errorFrom({ ...valid, ...production, DEV_AUTH_BYPASS: "false" });
      expect(error.message).toMatch(/DEV_AUTH_BYPASS/);
    });

    it("refuses NEON_WS_PROXY, which would turn off TLS to the database", () => {
      const error = errorFrom({
        ...valid,
        ...production,
        NEON_WS_PROXY: "localhost:5498/v1",
      });
      expect(error.message).toMatch(/NEON_WS_PROXY must not be set in production/);
    });

    it("accepts both left blank", () => {
      expect(() =>
        parseEnv({ ...valid, ...auth, ...production, DEV_AUTH_BYPASS: "", NEON_WS_PROXY: "" }),
      ).not.toThrow();
    });
  });

  describe.each([
    ["NODE_ENV=production", { NODE_ENV: "production" }],
    ["VERCEL_ENV=production", { VERCEL_ENV: "production" }],
    ["a Vercel preview", { NODE_ENV: "production", VERCEL_ENV: "preview" }],
  ])("sign-in with %s", (_name, production) => {
    it.each(Object.keys(auth))("refuses to run without %s", (key) => {
      const error = errorFrom({ ...valid, ...auth, ...production, [key]: "" });
      expect(error.message).toContain(`${key} is required in production`);
    });

    it("names everything missing at once", () => {
      const error = errorFrom({ ...valid, ...production });
      for (const key of Object.keys(auth)) expect(error.message).toContain(key);
    });

    it("accepts a complete environment", () => {
      expect(() => parseEnv({ ...valid, ...auth, ...production })).not.toThrow();
    });
  });

  it("doesn't echo the auth secret back", () => {
    const error = errorFrom({ ...valid, AUTH_SECRET: "too-short-to-be-safe" });
    expect(error.message).toMatch(/AUTH_SECRET must be at least 32 characters/);
    expect(error.message).not.toContain("too-short-to-be-safe");
  });

  it("doesn't need sign-in configured outside production", () => {
    expect(() => parseEnv(valid)).not.toThrow();
  });

  it("allows DEV_AUTH_BYPASS and NEON_WS_PROXY outside production", () => {
    const env = parseEnv({
      ...valid,
      NODE_ENV: "development",
      VERCEL_ENV: "preview",
      DEV_AUTH_BYPASS: "1",
      NEON_WS_PROXY: "localhost:5498/v1",
    });
    expect(env.DEV_AUTH_BYPASS).toBe("1");
    expect(env.NEON_WS_PROXY).toBe("localhost:5498/v1");
  });
});

describe("devAuthBypassEnabled", () => {
  afterEach(() => vi.unstubAllEnvs());

  const stubValidEnv = () => {
    for (const [key, value] of Object.entries(valid)) vi.stubEnv(key, value);
  };

  async function enabled() {
    vi.resetModules(); // fresh env cache per test
    const { devAuthBypassEnabled } = await import("./env");
    return devAuthBypassEnabled();
  }

  it("is on outside production when the variable is set", async () => {
    stubValidEnv();
    vi.stubEnv("DEV_AUTH_BYPASS", "1");
    expect(await enabled()).toBe(true);
  });

  it("is off when the variable is blank", async () => {
    stubValidEnv();
    vi.stubEnv("DEV_AUTH_BYPASS", "");
    expect(await enabled()).toBe(false);
  });

  it("is off in production even if startup validation never ran", async () => {
    stubValidEnv();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEV_AUTH_BYPASS", "1");
    expect(await enabled()).toBe(false);
  });
});
