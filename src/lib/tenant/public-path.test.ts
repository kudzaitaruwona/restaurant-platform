import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A customer's first scan hits a cold function, and a phone on a slow connection
 * waits for it. Better Auth is the heaviest thing in the app and the menu has no
 * use for it, so the public path must not load it (S-32).
 *
 * The image library and the S3 SDK are heavy too, and the page only prints
 * addresses, so it must not load them either.
 *
 * Importing any of the three here throws, so any route of the public path that
 * reaches one, however indirectly, fails to load.
 */
vi.mock("better-auth", () => {
  throw new Error("better-auth was loaded");
});
vi.mock("sharp", () => {
  throw new Error("sharp was loaded");
});
vi.mock("@aws-sdk/client-s3", () => {
  throw new Error("the S3 SDK was loaded");
});

beforeEach(() => {
  vi.resetModules();
});

describe("the public path", () => {
  it.each([
    ["the menu page", () => import("@/app/m/[menuToken]/route")],
    ["the page it renders", () => import("@/lib/public-menu")],
    ["the menu it reads", () => import("@/lib/menu")],
    ["the tenant scope", () => import("./scope")],
    ["the public seam", () => import("./public")],
    ["the photo addresses", () => import("@/lib/photo-urls")],
  ])("%s loads without better-auth, sharp or the S3 SDK", async (_name, load) => {
    await expect(load()).resolves.toBeDefined();
  });

  it("the tenant seam does load it, so the checks above mean something", async () => {
    await expect(import("@/lib/tenant")).rejects.toThrow("mocking a module");
  });

  it("the photo upload does load sharp, so the checks above mean something", async () => {
    await expect(import("@/lib/photo-image")).rejects.toThrow("mocking a module");
  });

  it("the storage client does load the S3 SDK, so the checks above mean something", async () => {
    await expect(import("@/lib/storage/storage")).rejects.toThrow("mocking a module");
  });
});
