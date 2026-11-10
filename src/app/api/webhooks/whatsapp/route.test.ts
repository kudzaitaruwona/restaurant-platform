import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Meta's webhook (spec 05, Delivery status), with the database write stood in
 * for: src/lib/whatsapp/delivery-status.int.test.ts proves what a status does to
 * a row as app_system. This proves who gets in, and that a refused call never
 * opens the system login.
 */
const APP_SECRET = "the-app-secret";
const VERIFY_TOKEN = "the-verify-token";
let env: { WHATSAPP_APP_SECRET?: string; WHATSAPP_WEBHOOK_VERIFY_TOKEN?: string };

vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  getEnv: () => env,
}));
const systemDb = { system: true };
const getSystemDb = vi.fn(() => systemDb);
vi.mock("@/db/system", () => ({ getSystemDb }));
const applyDeliveryStatuses = vi.fn();
vi.mock("@/lib/whatsapp/delivery-status", () => ({ applyDeliveryStatuses }));

const route = await import("./route");
const URL_BASE = "http://localhost/api/webhooks/whatsapp";

const callback = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "WABA",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            statuses: [
              { id: "wamid.A", status: "delivered", timestamp: "1700000000", recipient_id: "263771234567" },
              { id: "wamid.B", status: "failed", errors: [{ code: 131026, title: "Message undeliverable" }] },
            ],
          },
        },
      ],
    },
  ],
});
const sign = (body: string, secret = APP_SECRET) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const post = (body: string, headers: Record<string, string> = {}) =>
  route.POST(new Request(URL_BASE, { method: "POST", body, headers: { "content-type": "application/json", ...headers } }));

beforeEach(() => {
  env = { WHATSAPP_APP_SECRET: APP_SECRET, WHATSAPP_WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN };
  getSystemDb.mockClear();
  applyDeliveryStatuses.mockReset().mockResolvedValue(2);
});

describe("POST /api/webhooks/whatsapp", () => {
  it("writes the callback's statuses on the system login when Meta's signature checks out", async () => {
    const response = await post(callback, { "x-hub-signature-256": sign(callback) });

    expect(response.status).toBe(200);
    expect(applyDeliveryStatuses).toHaveBeenCalledWith(systemDb, [
      { providerMessageId: "wamid.A", status: "delivered" },
      { providerMessageId: "wamid.B", status: "failed", error: "Meta 131026: Message undeliverable" },
    ]);
  });

  it.each([
    ["no signature", {}],
    ["another secret's signature", { "x-hub-signature-256": sign(callback, "not-the-secret") }],
    ["a signature of another body", { "x-hub-signature-256": sign("{}") }],
  ])("rejects a callback with %s, with a 401, without opening the system login", async (_name, headers) => {
    const response = await post(callback, headers);
    expect(response.status).toBe(401);
    expect(getSystemDb).not.toHaveBeenCalled();
    expect(applyDeliveryStatuses).not.toHaveBeenCalled();
  });

  it("fails closed with no app secret set: even a callback signed with an empty secret is refused", async () => {
    env = { WHATSAPP_WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN };
    const response = await post(callback, { "x-hub-signature-256": sign(callback, "") });
    expect(response.status).toBe(401);
    expect(getSystemDb).not.toHaveBeenCalled();
  });

  it("answers 400 to a signed body that isn't JSON, writing nothing", async () => {
    const response = await post("not json", { "x-hub-signature-256": sign("not json") });
    expect(response.status).toBe(400);
    expect(applyDeliveryStatuses).not.toHaveBeenCalled();
  });

  it("acknowledges a callback with no status in it (an inbound message) without opening the login", async () => {
    const inbound = JSON.stringify({ entry: [{ changes: [{ field: "messages", value: { messages: [{ id: "x" }] } }] }] });
    const response = await post(inbound, { "x-hub-signature-256": sign(inbound) });
    expect(response.status).toBe(200);
    expect(getSystemDb).not.toHaveBeenCalled();
  });

  it("answers 500 when the write fails, so Meta tries again", async () => {
    applyDeliveryStatuses.mockRejectedValue(new Error("database down"));
    const response = await post(callback, { "x-hub-signature-256": sign(callback) });
    expect(response.status).toBe(500);
  });
});

describe("GET /api/webhooks/whatsapp (Meta's subscription handshake)", () => {
  const get = (params: Record<string, string>) =>
    route.GET(new Request(`${URL_BASE}?${new URLSearchParams(params)}`));

  it("echoes the challenge as plain text when the verify token matches", async () => {
    const response = await get({ "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "1158201444" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await response.text()).toBe("1158201444");
    expect(getSystemDb).not.toHaveBeenCalled();
  });

  it("refuses the wrong token with a 403", async () => {
    const response = await get({ "hub.mode": "subscribe", "hub.verify_token": "nope", "hub.challenge": "1" });
    expect(response.status).toBe(403);
  });

  it("refuses everything with no verify token set", async () => {
    env = { WHATSAPP_APP_SECRET: APP_SECRET };
    const response = await get({ "hub.mode": "subscribe", "hub.verify_token": "", "hub.challenge": "1" });
    expect(response.status).toBe(403);
  });
});

it("takes GET and POST only", () => {
  expect(Object.keys(route).filter((key) => /^[A-Z]+$/.test(key)).sort()).toEqual(["GET", "POST"]);
});
