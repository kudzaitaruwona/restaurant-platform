import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("@/lib/storage (R2-backed)", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgres://app_tenant:app_tenant@localhost:5499/x");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
    vi.stubEnv("R2_ACCOUNT_ID", "account");
    vi.stubEnv("R2_ACCESS_KEY_ID", "key");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "secret");
    vi.stubEnv("R2_BUCKET", "photos");
    vi.stubEnv("R2_PUBLIC_BASE_URL", "https://cdn.example.test/");
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("getUrl serves images from R2_PUBLIC_BASE_URL", async () => {
    const { getUrl } = await import("@/lib/storage");

    expect(getUrl("r/abc/x.webp")).toBe("https://cdn.example.test/r/abc/x.webp");
  });

  it("getUrl still refuses an unsafe key", async () => {
    const { getUrl } = await import("@/lib/storage");

    expect(() => getUrl("../x.webp")).toThrow(/key/);
  });

  it("uploadImage reaches the bucket through the S3 client, loaded on first use", async () => {
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementation(async () => ({}));
    const { uploadImage } = await import("@/lib/storage");

    const result = await uploadImage("r/abc/x.webp", new Uint8Array([1]), "image/webp");

    expect(result.url).toBe("https://cdn.example.test/r/abc/x.webp");
    expect(send.mock.calls[0][0]).toBeInstanceOf(PutObjectCommand);
  });
});
