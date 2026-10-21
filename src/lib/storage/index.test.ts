import { afterEach, describe, expect, it, vi } from "vitest";

describe("@/lib/storage (R2-backed)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("getUrl serves images from R2_PUBLIC_BASE_URL", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://app:app@localhost:5499/x");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
    vi.stubEnv("R2_ACCOUNT_ID", "account");
    vi.stubEnv("R2_ACCESS_KEY_ID", "key");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "secret");
    vi.stubEnv("R2_BUCKET", "photos");
    vi.stubEnv("R2_PUBLIC_BASE_URL", "https://cdn.example.test/");
    vi.resetModules();

    const { getUrl } = await import("@/lib/storage");

    expect(getUrl("r/abc/x.webp")).toBe("https://cdn.example.test/r/abc/x.webp");
  });
});
