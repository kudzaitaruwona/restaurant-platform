import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  codeFailureMessage,
  looksLikeEmail,
  ResendButton,
  sendFailureMessage,
  SignInForm,
  tooManyTriesMessage,
  WRONG_TRIES_ALLOWED,
} from "./sign-in-form";

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

  it("fills in the email an invite links with (S-42), and nothing else", () => {
    url.search = "?email=tendai%2Bwork%40example.test";
    const html = render();
    expect(html).toContain('value="tendai+work@example.test"');
    expect(html).toContain("Email me a sign-in link");
  });

  it("starts empty with no email in the address", () => {
    expect(render()).toContain('value=""');
  });

  it("ignores something too long to be an email", () => {
    url.search = `?email=${"a".repeat(300)}%40example.test`;
    expect(render()).toContain('value=""');
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

const answer = (status: number, code?: string) =>
  Response.json(code ? { code } : {}, { status });

describe("a send that fails says so (#92)", () => {
  it("asks for a real address when the server refuses it", async () => {
    expect(await sendFailureMessage(answer(400, "INVALID_EMAIL"), "code")).toMatch(
      /valid email/,
    );
  });

  it("says something for any other failure, in words that name no reason", async () => {
    for (const status of [400, 403, 404, 500, 502]) {
      const message = await sendFailureMessage(answer(status), "link");
      expect(message).toMatch(/couldn.t send/);
      expect(message).not.toMatch(/account|exist|known|registered/i);
    }
  });

  it("names the right thing for each way in", async () => {
    expect(await sendFailureMessage(answer(500), "link")).toMatch(/link/);
    expect(await sendFailureMessage(answer(500), "code")).toMatch(/code/);
    expect(await sendFailureMessage(answer(500), "google")).toMatch(/Google/);
  });

  it("keeps the rate-limit wording for a 429", async () => {
    expect(await sendFailureMessage(answer(429), "code")).toMatch(/Wait a minute/);
    expect(await sendFailureMessage(answer(429, "sign_in_codes_paused"), "code")).toMatch(
      /sign-in link or Google/,
    );
  });
});

describe("checking the email before a code is asked for (#92)", () => {
  it("refuses what is not an address", () => {
    for (const value of ["abc", "", "  ", "a@", "@b.c", "a b@c.d"]) {
      expect(looksLikeEmail(value)).toBe(false);
    }
  });

  it("accepts an address", () => {
    expect(looksLikeEmail("tendai+work@example.test")).toBe(true);
    expect(looksLikeEmail(" tendai@example.test ")).toBe(true);
  });
});

describe("a code that didn't work (#92)", () => {
  it("says to check it while tries remain", async () => {
    const message = await codeFailureMessage(answer(400, "INVALID_OTP"), 1);
    expect(message).toMatch(/check it/i);
  });

  it("says to request a new one once the code is burned", async () => {
    const third = await codeFailureMessage(answer(400, "INVALID_OTP"), WRONG_TRIES_ALLOWED);
    expect(third).toMatch(/request a new/i);
    expect(third).not.toMatch(/check it/i);
    const server = await codeFailureMessage(answer(403, "TOO_MANY_ATTEMPTS"), 1);
    expect(server).toMatch(/request a new/i);
    expect(server).not.toMatch(/check it/i);
  });

  it("says an expired code is expired", async () => {
    expect(await codeFailureMessage(answer(400, "OTP_EXPIRED"), 1)).toMatch(
      /expired.*request a new/i,
    );
  });

  it("is the same for any email, since the server is", async () => {
    expect(await codeFailureMessage(answer(500), 1)).toMatch(/request a new|try again/i);
  });
});

describe("the resend button (#92)", () => {
  it("offers a new code or link", () => {
    const html = renderToStaticMarkup(
      <ResendButton what="code" seconds={0} busy={false} onClick={() => {}} />,
    );
    expect(html).toContain("Send a new code");
    expect(html).not.toContain('disabled=""');
  });

  it("waits out a cooldown and says for how long", () => {
    const html = renderToStaticMarkup(
      <ResendButton what="link" seconds={24} busy={false} onClick={() => {}} />,
    );
    expect(html).toContain("Send a new link in 24s");
    expect(html).toContain('disabled=""');
  });

  it("is off while something is being sent", () => {
    const html = renderToStaticMarkup(
      <ResendButton what="code" seconds={0} busy onClick={() => {}} />,
    );
    expect(html).toContain('disabled=""');
  });
});
