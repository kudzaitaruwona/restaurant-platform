import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignOutButton } from "./sign-out-button";

const router = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => router }));

const click = (audience: "staff" | "admin") => {
  const button = SignOutButton({ audience }) as ReactElement<{
    onClick: () => Promise<void>;
  }>;
  return button.props.onClick();
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: true })));
  router.replace.mockClear();
});

describe("signing out", () => {
  it.each([
    ["staff", "/api/auth/staff/sign-out", "/login"],
    ["admin", "/api/auth/admin/sign-out", "/login/admin"],
  ] as const)("%s ends their own session and goes back to their sign-in", async (audience, endpoint, page) => {
    await click(audience);

    expect(fetch).toHaveBeenCalledWith(endpoint, expect.objectContaining({ method: "POST" }));
    expect(router.replace).toHaveBeenCalledWith(page);
  });
});
