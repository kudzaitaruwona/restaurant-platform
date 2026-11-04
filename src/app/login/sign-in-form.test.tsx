import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignInForm } from "./sign-in-form";

const url = vi.hoisted(() => ({ search: "" }));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(url.search),
}));

const render = () =>
  renderToStaticMarkup(
    <SignInForm audience="staff" destination="/dashboard" page="/login" />,
  );

beforeEach(() => {
  url.search = "";
});

describe("the sign-in form", () => {
  it("offers all three ways in", () => {
    const html = render();
    expect(html).toContain("Email me a sign-in link");
    expect(html).toContain("Email me a code instead");
    expect(html).toContain("Sign in with Google");
  });

  it("never asks for a password (S-27)", () => {
    expect(render()).not.toMatch(/password/i);
  });

  it("explains a refused Google account without saying why", () => {
    url.search = "?error=sign_in_refused";
    expect(render()).toContain("couldn&#x27;t sign you in");
  });

  it("explains a dead link", () => {
    url.search = "?error=INVALID_TOKEN";
    expect(render()).toContain("expired");
  });
});
