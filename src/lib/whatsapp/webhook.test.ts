import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deliveryStatuses, isSignedByMeta, verificationChallenge } from "./webhook";

const SECRET = "the-app-secret";
const body = Buffer.from('{"object":"whatsapp_business_account","entry":[]}');
const signatureOf = (bytes: Buffer, secret = SECRET) =>
  `sha256=${createHmac("sha256", secret).update(bytes).digest("hex")}`;

describe("isSignedByMeta (X-Hub-Signature-256)", () => {
  it("accepts the HMAC-SHA256 of the raw body under the app secret", () => {
    expect(isSignedByMeta(body, signatureOf(body), SECRET)).toBe(true);
  });

  it.each([
    ["no header", null],
    ["another secret's signature", signatureOf(body, "another-secret")],
    ["a signature of another body", signatureOf(Buffer.from("{}"))],
    ["the digest without its scheme", signatureOf(body).slice("sha256=".length)],
    ["a sha1 signature", `sha1=${createHmac("sha1", SECRET).update(body).digest("hex")}`],
    ["a truncated digest", signatureOf(body).slice(0, -2)],
    ["something that isn't hex", `sha256=${"z".repeat(64)}`],
    ["an empty header", ""],
  ])("refuses %s", (_name, header) => {
    expect(isSignedByMeta(body, header, SECRET)).toBe(false);
  });

  it("is checked over the exact bytes, not a re-encoding of them", () => {
    const raw = Buffer.from([0x7b, 0xff, 0x7d]); // not valid UTF-8
    expect(isSignedByMeta(raw, signatureOf(raw), SECRET)).toBe(true);
    expect(isSignedByMeta(Buffer.from(raw.toString("utf8")), signatureOf(raw), SECRET)).toBe(false);
  });

  it.each([undefined, ""])("fails closed when the app secret is %j: nothing is accepted", (secret) => {
    expect(isSignedByMeta(body, signatureOf(body, ""), secret)).toBe(false);
  });
});

describe("verificationChallenge (Meta's GET handshake)", () => {
  const params = (values: Record<string, string>) => new URLSearchParams(values);
  const TOKEN = "the-verify-token";

  it("hands back the challenge when the mode is subscribe and the token matches", () => {
    expect(
      verificationChallenge(params({ "hub.mode": "subscribe", "hub.verify_token": TOKEN, "hub.challenge": "1158201444" }), TOKEN),
    ).toBe("1158201444");
  });

  it.each([
    ["the wrong token", { "hub.mode": "subscribe", "hub.verify_token": "nope", "hub.challenge": "1" }],
    ["another mode", { "hub.mode": "unsubscribe", "hub.verify_token": TOKEN, "hub.challenge": "1" }],
    ["no challenge", { "hub.mode": "subscribe", "hub.verify_token": TOKEN }],
    ["a challenge that isn't a plain token", { "hub.mode": "subscribe", "hub.verify_token": TOKEN, "hub.challenge": "<script>" }],
  ])("refuses %s", (_name, values) => {
    expect(verificationChallenge(params(values), TOKEN)).toBeNull();
  });

  it.each([undefined, ""])("refuses everything when the verify token is %j", (token) => {
    expect(
      verificationChallenge(params({ "hub.mode": "subscribe", "hub.verify_token": "", "hub.challenge": "1" }), token),
    ).toBeNull();
  });
});

describe("deliveryStatuses", () => {
  const callback = (statuses: unknown[], field = "messages") => ({
    object: "whatsapp_business_account",
    entry: [{ id: "WABA", changes: [{ field, value: { messaging_product: "whatsapp", statuses } }] }],
  });

  it("reads each message's id and status from Meta's callback", () => {
    expect(
      deliveryStatuses(
        callback([
          { id: "wamid.A", status: "delivered", timestamp: "1700000000", recipient_id: "263771234567" },
          { id: "wamid.B", status: "read", timestamp: "1700000001", recipient_id: "263771234567" },
        ]),
      ),
    ).toEqual([
      { providerMessageId: "wamid.A", status: "delivered" },
      { providerMessageId: "wamid.B", status: "read" },
    ]);
  });

  it("keeps the first error of a failed message, at most 500 characters", () => {
    const [status] = deliveryStatuses(
      callback([
        {
          id: "wamid.F",
          status: "failed",
          errors: [{ code: 131026, title: "Message undeliverable", message: "x".repeat(600) }],
        },
      ]),
    );
    expect(status).toEqual({ providerMessageId: "wamid.F", status: "failed", error: "Meta 131026: Message undeliverable" });

    const [long] = deliveryStatuses(
      callback([{ id: "wamid.G", status: "failed", errors: [{ code: 1, title: "y".repeat(600) }] }]),
    );
    expect(long.error).toHaveLength(500);
  });

  it("ignores statuses it doesn't track, other fields, and anything malformed", () => {
    expect(deliveryStatuses(callback([{ id: "wamid.D", status: "deleted" }]))).toEqual([]);
    expect(deliveryStatuses(callback([{ id: "wamid.S", status: "sent" }], "account_update"))).toEqual([]);
    expect(deliveryStatuses(callback([{ status: "sent" }, { id: 7, status: "sent" }, null, "x"]))).toEqual([]);
    for (const nonsense of [null, 7, "x", {}, { entry: "x" }, { entry: [{ changes: [null] }] }]) {
      expect(deliveryStatuses(nonsense)).toEqual([]);
    }
  });

  it("ignores inbound messages, which carry no statuses", () => {
    expect(
      deliveryStatuses({
        entry: [{ changes: [{ field: "messages", value: { messages: [{ id: "wamid.IN", type: "text" }] } }] }],
      }),
    ).toEqual([]);
  });
});
