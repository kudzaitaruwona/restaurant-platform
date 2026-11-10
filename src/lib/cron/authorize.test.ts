import { describe, expect, it } from "vitest";
import { isAuthorizedCronCall } from "./authorize";

/**
 * S-35: Vercel sends `Authorization: Bearer <CRON_SECRET>` on every cron call,
 * and the route refuses anything else. It fails closed: no secret, or one too
 * short to be one, refuses every call, even one that matches it.
 */
const SECRET = "a-cron-secret-of-at-least-32-characters";

describe("isAuthorizedCronCall", () => {
  it("accepts the bearer token Vercel sends", () => {
    expect(isAuthorizedCronCall(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it.each([
    ["no header", null],
    ["an empty header", ""],
    ["the wrong secret", `Bearer ${SECRET.slice(0, -1)}x`],
    ["the secret with something after it", `Bearer ${SECRET} `],
    ["a prefix of the secret", `Bearer ${SECRET.slice(0, -1)}`],
    ["the secret without the scheme", SECRET],
    ["another scheme", `Basic ${SECRET}`],
    ["the scheme in another case", `bearer ${SECRET}`],
  ])("refuses %s", (_name, header) => {
    expect(isAuthorizedCronCall(header, SECRET)).toBe(false);
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["31 characters", "x".repeat(31)],
  ])("refuses every call when CRON_SECRET is %s", (_name, secret) => {
    expect(isAuthorizedCronCall(`Bearer ${secret ?? ""}`, secret)).toBe(false);
    expect(isAuthorizedCronCall("Bearer ", secret)).toBe(false);
    expect(isAuthorizedCronCall(null, secret)).toBe(false);
  });

  it("accepts a secret of exactly 32 characters", () => {
    const secret = "y".repeat(32);
    expect(isAuthorizedCronCall(`Bearer ${secret}`, secret)).toBe(true);
  });
});
