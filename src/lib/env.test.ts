import { describe, expect, it } from "vitest";
import { EnvValidationError, parseEnv } from "./env";

const valid = {
  DATABASE_URL: "postgres://app:app@localhost:5499/restaurant_dev",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  R2_ACCOUNT_ID: "account",
  R2_ACCESS_KEY_ID: "key",
  R2_SECRET_ACCESS_KEY: "secret",
  R2_BUCKET: "photos",
  R2_PUBLIC_BASE_URL: "https://images.example.test",
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
});
