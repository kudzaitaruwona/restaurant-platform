import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignInForm, tooManyTriesMessage } from "./sign-in-form";

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

describe("being told to stop", () => {
  it("points at the other ways in when this email has run out of codes", async () => {
    const response = Response.json({ code: "sign_in_codes_paused" }, { status: 429 });
    expect(await tooManyTriesMessage(response)).toMatch(/sign-in link or Google/);
  });

  it("says to wait when it's only the limit on this connection", async () => {
    const response = Response.json({ message: "Too many requests." }, { status: 429 });
    expect(await tooManyTriesMessage(response)).toMatch(/Wait a minute/);
  });

  it("says to wait when the answer isn't JSON", async () => {
    const response = new Response("Slow down", { status: 429 });
    expect(await tooManyTriesMessage(response)).toMatch(/Wait a minute/);
  });
});
