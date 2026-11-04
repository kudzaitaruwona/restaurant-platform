import { afterEach, describe, expect, it, vi } from "vitest";
import { resendSender, signInCodeEmail, signInLinkEmail } from "./email";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resendSender", () => {
  const email = { to: "a@example.test", subject: "Hi", text: "Body" };

  it("posts the email to Resend with the key", async () => {
    const fetchSpy = vi.fn(async () => Response.json({ id: "1" }));
    vi.stubGlobal("fetch", fetchSpy);

    await resendSender("re_key", "From <f@example.test>").send(email);

    expect(fetchSpy).toHaveBeenCalledWith("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: "Bearer re_key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: "From <f@example.test>",
        to: ["a@example.test"],
        subject: "Hi",
        text: "Body",
      }),
    });
  });

  it("fails loudly on a refusal, without quoting the response or the key", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response("a@example.test is on a list", { status: 422 }),
    );
    const failure = resendSender("re_key", "f@example.test").send(email);
    await expect(failure).rejects.toThrow("Resend answered 422");
    await expect(failure).rejects.not.toThrow(/a@example|re_key/);
  });
});

describe("the emails", () => {
  it("a link email has the link on a line of its own and says it expires", () => {
    const { text } = signInLinkEmail("a@example.test", "https://x.test/v?t=1", 10);
    expect(text).toContain("\nhttps://x.test/v?t=1\n");
    expect(text).toContain("10 minutes");
  });

  it("a code email has the code", () => {
    const { subject, text } = signInCodeEmail("a@example.test", "123456", 10);
    expect(subject).toContain("123456");
    expect(text).toContain("123456");
  });
});
