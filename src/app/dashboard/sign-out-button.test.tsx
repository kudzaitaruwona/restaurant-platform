import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignOutButton, signOut } from "./sign-out-button";

/**
 * No DOM here, so the decision is tested in signOut(), which the button calls
 * and which holds everything but its pending and message state.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace() {} }) }));

const go = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: true })));
  go.mockClear();
});

describe("signing out", () => {
  it.each([
    ["staff", "/api/auth/staff/sign-out", "/login"],
    ["admin", "/api/auth/admin/sign-out", "/login/admin"],
  ] as const)("%s ends their own session and goes back to their sign-in", async (audience, endpoint, page) => {
    const problem = await signOut(audience, go);

    expect(fetch).toHaveBeenCalledWith(endpoint, expect.objectContaining({ method: "POST" }));
    expect(go).toHaveBeenCalledWith(page);
    expect(problem).toBeUndefined();
  });

  it.each([500, 429])("stays put and says so on a %i", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status })));

    const problem = await signOut("staff", go);

    expect(go).not.toHaveBeenCalled();
    expect(problem).toMatch(/still signed in/);
  });

  it("stays put and says so when the request never lands", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));

    const problem = await signOut("staff", go);

    expect(go).not.toHaveBeenCalled();
    expect(problem).toMatch(/still be signed in/);
  });
});

describe("the button", () => {
  it("offers to sign out, and shows no message to start with", () => {
    const html = renderToStaticMarkup(<SignOutButton audience="staff" />);
    expect(html).toContain("Sign out");
    expect(html).not.toContain('role="alert"');
    expect(html).not.toMatch(/<button[^>]* disabled=/);
  });
});
