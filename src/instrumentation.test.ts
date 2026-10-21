import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const validEnv = {
  DATABASE_URL: "postgres://app:app@localhost:5499/restaurant_dev",
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

  it("does not validate during `next build`, which runs without runtime secrets", async () => {
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    vi.stubEnv("DATABASE_URL", "");
    await expect(register()).resolves.toBeUndefined();
  });
});
