import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const validEnv = {
  DATABASE_URL: "postgres://app_tenant:app_tenant@localhost:5499/restaurant_dev",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  R2_ACCOUNT_ID: "account",
  R2_ACCESS_KEY_ID: "key",
  R2_SECRET_ACCESS_KEY: "secret",
  R2_BUCKET: "photos",
  R2_PUBLIC_BASE_URL: "https://images.example.test",
  AUTH_SECRET: "a-secret-of-at-least-thirty-two-characters",
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  RESEND_API_KEY: "re_key",
  EMAIL_FROM: "Sign-in <sign-in@example.test>",
};

async function register() {
  vi.resetModules(); // fresh env cache per test
  const instrumentation = await import("./instrumentation");
  return instrumentation.register();
}

/**
 * Runs register() the way `next start` does and expects it to end the process.
 * A rejected register() is not enough: Next.js logs that and keeps serving. The
 * real exit is proven against a built server by the smoke step in CI.
 */
async function expectRefusal(problem: RegExp) {
  await expect(register()).rejects.toThrow("process.exit");
  expect(process.exit).toHaveBeenCalledWith(1);
  expect(logged()).toMatch(problem);
}

const logged = () => vi.mocked(console.error).mock.calls.flat().join("\n");

describe("server startup (instrumentation register)", () => {
  beforeEach(() => {
    for (const [key, value] of Object.entries(validEnv)) vi.stubEnv(key, value);
    vi.stubEnv("NEXT_PHASE", "");
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    // Throws because the real one never returns.
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("starts when the environment is valid", async () => {
    await expect(register()).resolves.toBeUndefined();
    expect(process.exit).not.toHaveBeenCalled();
  });

  it("exits, naming the variable, when a required one is missing", async () => {
    vi.stubEnv("R2_PUBLIC_BASE_URL", "");
    await expectRefusal(/R2_PUBLIC_BASE_URL is missing/);
  });

  it("exits when a variable is invalid", async () => {
    vi.stubEnv("R2_PUBLIC_BASE_URL", "https://pub-123.r2.dev");
    await expectRefusal(/R2_PUBLIC_BASE_URL/);
  });

  it("logs the variable's name and never its value", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://someone_else:hunter2@host/db");
    await expectRefusal(/DATABASE_URL/);
    expect(logged()).not.toContain("hunter2");
  });

  it("rejects instead outside Node.js, where there is no process to exit", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    vi.stubEnv("R2_PUBLIC_BASE_URL", "");
    await expect(register()).rejects.toThrow(/R2_PUBLIC_BASE_URL is missing/);
    expect(process.exit).not.toHaveBeenCalled();
  });

  describe("in production", () => {
    beforeEach(() => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("NEON_WS_PROXY", "");
      vi.stubEnv("DEV_AUTH_BYPASS", "");
    });

    it("starts when neither development switch is set", async () => {
      await expect(register()).resolves.toBeUndefined();
      expect(process.exit).not.toHaveBeenCalled();
    });

    it("exits with DEV_AUTH_BYPASS set (S-25)", async () => {
      vi.stubEnv("DEV_AUTH_BYPASS", "1");
      await expectRefusal(/DEV_AUTH_BYPASS/);
    });

    it("exits with NEON_WS_PROXY set", async () => {
      vi.stubEnv("NEON_WS_PROXY", "localhost:5498/v1");
      await expectRefusal(/NEON_WS_PROXY/);
    });

    it("the lazy getEnv() fallback refuses too, should startup validation be skipped", async () => {
      vi.stubEnv("NEXT_PHASE", "phase-production-build");
      vi.stubEnv("DEV_AUTH_BYPASS", "1");
      await expect(register()).resolves.toBeUndefined();
      expect(process.exit).not.toHaveBeenCalled();

      const { getEnv } = await import("./lib/env");
      expect(() => getEnv()).toThrow(/DEV_AUTH_BYPASS/);
    });
  });

  it("does not validate during `next build`, which runs without runtime secrets", async () => {
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    vi.stubEnv("DATABASE_URL", "");
    await expect(register()).resolves.toBeUndefined();
    expect(process.exit).not.toHaveBeenCalled();
  });
});
