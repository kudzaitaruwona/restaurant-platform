import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A customer's first scan hits a cold function, and a phone on a slow connection
 * waits for it. Better Auth is the heaviest thing in the app and the menu has no
 * use for it, so the public path must not load it (S-32).
 *
 * Importing better-auth here throws, so any route of the public path that reaches
 * it, however indirectly, fails to load.
 */
vi.mock("better-auth", () => {
  throw new Error("better-auth was loaded");
});

beforeEach(() => {
  vi.resetModules();
});

describe("the public path", () => {
  it.each([
    ["the menu page", () => import("@/app/m/[menuToken]/route")],
    ["the table code's page", () => import("@/app/t/[qrToken]/route")],
    ["the guest's manage page", () => import("@/app/b/[manageToken]/route")],
    ["the guest's booking route", () => import("@/app/api/r/[slug]/book/route")],
    ["the bookings it reads", () => import("@/lib/bookings")],
    ["the page it renders", () => import("@/lib/public-menu")],
    ["the menu it reads", () => import("@/lib/menu")],
    ["the tenant scope", () => import("./scope")],
    ["the public seam", () => import("./public")],
  ])("%s loads without better-auth", async (_name, load) => {
    await expect(load()).resolves.toBeDefined();
  });

  it("the tenant seam does load it, so the checks above mean something", async () => {
    await expect(import("@/lib/tenant")).rejects.toThrow("mocking a module");
  });
});
