import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { passesBotCheck, type SiteVerify, verifyWithCloudflare, type Verdict } from "./bot-check";

/** Nothing here reaches Cloudflare: a fake stands where its answer would come from. */
const fake = (verdict: Verdict) => vi.fn<SiteVerify>(async () => verdict);
const input = { token: "tok", ip: "203.0.113.7" };
const keyed = { secret: "secret", production: true };

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("the bot check's policy", () => {
  it("lets a token Cloudflare accepts through, and sends it the secret, token and address", async () => {
    const verify = fake("valid");
    expect(await passesBotCheck(input, keyed, verify)).toBe(true);
    expect(verify).toHaveBeenCalledWith({ secret: "secret", token: "tok", ip: "203.0.113.7" });
  });

  it("refuses a token Cloudflare rejects", async () => {
    expect(await passesBotCheck(input, keyed, fake("invalid"))).toBe(false);
  });

  it.each([undefined, "", "x".repeat(2049)])(
    "refuses a missing or absurd token (%j) without asking Cloudflare",
    async (token) => {
      const verify = fake("valid");
      expect(await passesBotCheck({ token, ip: undefined }, keyed, verify)).toBe(false);
      expect(verify).not.toHaveBeenCalled();
    },
  );

  describe("with no secret", () => {
    it("goes on in development and tests, and never asks Cloudflare", async () => {
      const verify = fake("invalid");
      expect(await passesBotCheck(input, { secret: undefined, production: false }, verify)).toBe(true);
      expect(await passesBotCheck({ token: undefined, ip: undefined }, { secret: undefined, production: false }, verify)).toBe(true);
      expect(verify).not.toHaveBeenCalled();
    });

    it("refuses in production (fails closed) and says why", async () => {
      expect(await passesBotCheck(input, { secret: undefined, production: true }, fake("valid"))).toBe(false);
      expect(console.error).toHaveBeenCalled();
    });
  });

  describe("when Cloudflare refuses our own secret", () => {
    it("is development going on, and production failing closed", async () => {
      expect(await passesBotCheck(input, { secret: "bad", production: false }, fake("misconfigured"))).toBe(true);
      expect(await passesBotCheck(input, { secret: "bad", production: true }, fake("misconfigured"))).toBe(false);
    });
  });

  describe("when Cloudflare can't be reached", () => {
    it.each([true, false])("goes on (fails open) with production %s, and says so", async (production) => {
      expect(await passesBotCheck(input, { secret: "secret", production }, fake("unavailable"))).toBe(true);
      expect(console.warn).toHaveBeenCalled();
    });
  });

  it("logs no token or secret", async () => {
    await passesBotCheck({ token: "SECRET-TOKEN", ip: undefined }, { secret: "SECRET-KEY", production: true }, fake("unavailable"));
    const logged = JSON.stringify(vi.mocked(console.warn).mock.calls);
    expect(logged).not.toContain("SECRET-TOKEN");
    expect(logged).not.toContain("SECRET-KEY");
  });
});

describe("the call to Cloudflare, with fetch stubbed", () => {
  const stub = (respond: () => Response | Promise<Response>) => {
    const calls: { url: string; body: URLSearchParams }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body as URLSearchParams });
      return respond();
    });
    return calls;
  };
  afterEach(() => vi.unstubAllGlobals());
  const ask = () => verifyWithCloudflare({ secret: "s", token: "t", ip: "203.0.113.7" });

  it("posts the secret, token and address to siteverify, and reads success", async () => {
    const calls = stub(() => Response.json({ success: true }));

    expect(await ask()).toBe("valid");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(Object.fromEntries(calls[0].body)).toEqual({ secret: "s", response: "t", remoteip: "203.0.113.7" });
  });

  it.each([
    ["a rejected token", { success: false, "error-codes": ["invalid-input-response"] }, "invalid"],
    ["a used token", { success: false, "error-codes": ["timeout-or-duplicate"] }, "invalid"],
    ["our bad secret", { success: false, "error-codes": ["invalid-input-secret"] }, "misconfigured"],
    ["Cloudflare's own error", { success: false, "error-codes": ["internal-error"] }, "unavailable"],
    ["no reason", { success: false }, "invalid"],
  ])("reads %s", async (_name, answer, verdict) => {
    stub(() => Response.json(answer));
    expect(await ask()).toBe(verdict);
  });

  it.each([
    ["a 500", () => new Response("no", { status: 500 })],
    ["not JSON", () => new Response("<html>", { status: 200 })],
    ["the network failing", () => Promise.reject(new TypeError("fetch failed"))],
  ])("is unavailable on %s", async (_name, respond) => {
    stub(respond);
    expect(await ask()).toBe("unavailable");
  });
});
