import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inviteLink,
  ownerInviteEmail,
  resendSender,
  signInCodeEmail,
  signInLinkEmail,
  staffInviteEmail,
} from "./email";

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
      signal: expect.any(AbortSignal),
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

  it("gives up on a call that hangs, after 10 seconds", async () => {
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation(() => AbortSignal.abort(new DOMException("Late", "TimeoutError")));
    vi.stubGlobal(
      "fetch",
      (_url: string, { signal }: RequestInit) =>
        new Promise((_resolve, reject) => {
          if (signal?.aborted) reject(signal.reason);
          signal?.addEventListener("abort", () => reject(signal.reason));
        }),
    );

    await expect(resendSender("re_key", "f@example.test").send(email)).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(timeout).toHaveBeenCalledWith(10_000);
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

describe("invites (S-42)", () => {
  const appUrl = "https://app.example.test";

  it("link to the sign-in page with the email filled in, and nothing secret", () => {
    expect(inviteLink(appUrl, "ana+work@example.test")).toBe(
      "https://app.example.test/login?email=ana%2Bwork%40example.test",
    );
  });

  const staffInvite = staffInviteEmail({
    to: "tendai@example.test",
    name: "Tendai Moyo",
    restaurantName: "Mama's Kitchen",
    addedBy: "Rudo Chari",
    role: "staff",
    appUrl,
  });
  const ownerInvite = ownerInviteEmail({
    to: "rudo@example.test",
    name: "Rudo Chari",
    restaurantName: "Mama's Kitchen",
    appUrl,
  });

  it("a staff invite names the restaurant and who added them, and links to sign-in", () => {
    expect(staffInvite.to).toBe("tendai@example.test");
    expect(staffInvite.subject).toBe("Rudo Chari added you to Mama's Kitchen");
    expect(staffInvite.text).toMatch(/^Hi Tendai,/);
    expect(staffInvite.text).toContain("Rudo Chari added you to Mama's Kitchen");
    expect(staffInvite.text).toContain(
      `\n${inviteLink(appUrl, "tendai@example.test")}\n`,
    );
    expect(staffInvite.text).toContain("tendai@example.test");
  });

  it("says an owner is joining as an owner", () => {
    const { text } = staffInviteEmail({
      to: "o@example.test",
      name: "O",
      restaurantName: "R",
      addedBy: "A",
      role: "owner",
      appUrl,
    });
    expect(text).toContain("as an owner");
  });

  it("an owner invite says the restaurant is set up for them", () => {
    expect(ownerInvite.to).toBe("rudo@example.test");
    expect(ownerInvite.subject).toBe("Mama's Kitchen is ready for you");
    expect(ownerInvite.text).toContain("Mama's Kitchen is set up for you on restaurant-platform");
    expect(ownerInvite.text).toContain("You are its owner.");
    expect(ownerInvite.text).toContain(`\n${inviteLink(appUrl, "rudo@example.test")}\n`);
  });

  it.each([
    ["staff", staffInvite],
    ["owner", ownerInvite],
  ])("a %s invite asks for no password and has no dashes", (_kind, { subject, text }) => {
    expect(text).toContain("There is no password.");
    expect(`${subject}${text}`).not.toMatch(/[\u2013\u2014]/);
  });
});
