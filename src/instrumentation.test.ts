import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const validEnv = {
  DATABASE_URL: "postgres://app_tenant:app_tenant@localhost:5499/restaurant_dev",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  R2_ACCOUNT_ID: "account",
  R2_ACCESS_KEY_ID: "key",
  R2_SECRET_ACCESS_KEY: "secret",
  R2_BUCKET: "photos",
  R2_PUBLIC_BASE_URL: "https://images.example.test",
};

async function register() {
  vi.resetModules(); // fresh env cache per test
  const instrumentation = await import("./instrumentation");
  return instrumentation.register();
}

describe("server startup (instrumentation register)", () => {
  beforeEach(() => {
    for (const [key, value] of Object.entries(validEnv)) vi.stubEnv(key, value);
    vi.stubEnv("NEXT_PHASE", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("starts when the environment is valid", async () => {
    await expect(register()).resolves.toBeUndefined();
  });

  it("refuses to start, naming the variable, when a required one is missing", async () => {
    vi.stubEnv("R2_PUBLIC_BASE_URL", "");
    await expect(register()).rejects.toThrow(/R2_PUBLIC_BASE_URL is missing/);
  });

  it("refuses to start when a variable is invalid", async () => {
    vi.stubEnv("R2_PUBLIC_BASE_URL", "https://pub-123.r2.dev");
    await expect(register()).rejects.toThrow(/R2_PUBLIC_BASE_URL/);
  });

  describe("in production", () => {
    beforeEach(() => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("NEON_WS_PROXY", "");
      vi.stubEnv("DEV_AUTH_BYPASS", "");
    });

    it("starts when neither development switch is set", async () => {
      await expect(register()).resolves.toBeUndefined();
    });

    it("refuses to start with DEV_AUTH_BYPASS set (S-25)", async () => {
      vi.stubEnv("DEV_AUTH_BYPASS", "1");
      await expect(register()).rejects.toThrow(/DEV_AUTH_BYPASS/);
    });

    it("refuses to start with NEON_WS_PROXY set", async () => {
      vi.stubEnv("NEON_WS_PROXY", "localhost:5498/v1");
      await expect(register()).rejects.toThrow(/NEON_WS_PROXY/);
    });

    it("the lazy getEnv() fallback refuses too, should startup validation be skipped", async () => {
      vi.stubEnv("NEXT_PHASE", "phase-production-build");
      vi.stubEnv("DEV_AUTH_BYPASS", "1");
      await expect(register()).resolves.toBeUndefined();

      const { getEnv } = await import("./lib/env");
      expect(() => getEnv()).toThrow(/DEV_AUTH_BYPASS/);
    });
  });

  it("does not validate during `next build`, which runs without runtime secrets", async () => {
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    vi.stubEnv("DATABASE_URL", "");
    await expect(register()).resolves.toBeUndefined();
  });
});
