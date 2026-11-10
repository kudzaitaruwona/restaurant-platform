import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chooseSender, consoleSender, GRAPH_API_VERSION, metaSender } from "./sender";
import type { TemplateMessage } from "./templates";

const message: TemplateMessage = {
  to: "+263779876543",
  template: "booking_confirmed",
  language: "en",
  body: ["Tariro Moyo", "Kudu Grill", "4", "Fri 6 Nov", "19:30", "+263771234567"],
  manageToken: "AbCdEfGhIjKlMnOpQrStUv",
};

/** A stand-in for Meta's Graph API: records each request, answers what a test says. */
let server: Server;
let baseUrl: string;
let requests: { method?: string; url?: string; headers: IncomingMessage["headers"]; body: unknown }[] = [];
let answer: { status: number; body: string } = { status: 200, body: "{}" };

beforeAll(async () => {
  server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, headers: request.headers, body: JSON.parse(raw) });
      response.writeHead(answer.status, { "content-type": "application/json" }).end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));
afterEach(() => {
  requests = [];
  vi.restoreAllMocks();
});

const sender = () => metaSender({ phoneNumberId: "123456789", accessToken: "test-token", baseUrl });

describe("the Meta Cloud API sender", () => {
  it("posts the template message to /{phone number id}/messages with the bearer token, and returns Meta's message id", async () => {
    answer = { status: 200, body: JSON.stringify({ messages: [{ id: "wamid.HBgM" }] }) };

    expect(await sender().send(message)).toEqual({ ok: true, providerMessageId: "wamid.HBgM" });

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request.method).toBe("POST");
    expect(request.url).toBe(`/${GRAPH_API_VERSION}/123456789/messages`);
    expect(request.headers.authorization).toBe("Bearer test-token");
    expect(request.headers["content-type"]).toContain("application/json");
    expect(request.body).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "+263779876543",
      type: "template",
      template: {
        name: "booking_confirmed",
        language: { code: "en" },
        components: [
          { type: "body", parameters: message.body.map((text) => ({ type: "text", text })) },
          {
            type: "button",
            sub_type: "url",
            index: "0",
            parameters: [{ type: "text", text: "AbCdEfGhIjKlMnOpQrStUv" }],
          },
        ],
      },
    });
  });

  it("treats a non-2xx answer as a failed send, keeping Meta's error for last_error", async () => {
    answer = {
      status: 400,
      body: JSON.stringify({ error: { message: "Template name does not exist in the translation", code: 132001 } }),
    };

    expect(await sender().send(message)).toEqual({
      ok: false,
      error: "Meta 400 (132001): Template name does not exist in the translation",
    });
  });

  it("keeps the status alone when the error body isn't Meta's JSON", async () => {
    answer = { status: 502, body: "<html>Bad gateway</html>" };
    expect(await sender().send(message)).toEqual({ ok: false, error: "Meta 502" });
  });

  it("doesn't call it sent when Meta answers 2xx without a message id", async () => {
    answer = { status: 200, body: JSON.stringify({}) };
    expect(await sender().send(message)).toMatchObject({ ok: false });
  });

  it("turns a network failure into a failed send rather than throwing", async () => {
    const unreachable = metaSender({ phoneNumberId: "1", accessToken: "t", baseUrl: "http://127.0.0.1:1" });
    expect(await unreachable.send(message)).toMatchObject({ ok: false, error: expect.stringMatching(/^Meta request failed/) });
  });

  it("keeps last_error within the column's 500 characters", async () => {
    answer = { status: 400, body: JSON.stringify({ error: { message: "x".repeat(2000), code: 1 } }) };
    const result = await sender().send(message);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeLessThanOrEqual(500);
  });
});

describe("the console sender", () => {
  it("prints the message as the guest would read it and returns a recognisable fake id", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});

    const result = await consoleSender().send(message);

    expect(result).toEqual({ ok: true, providerMessageId: expect.stringMatching(/^console-/) });
    const printed = log.mock.calls.flat().join("\n");
    expect(printed).toContain("+263779876543");
    expect(printed).toContain("Hi Tariro Moyo, your table at Kudu Grill is confirmed for 4 people on Fri 6 Nov at 19:30.");
  });
});

describe("chooseSender", () => {
  const keys = { WHATSAPP_PHONE_NUMBER_ID: "123456789", WHATSAPP_ACCESS_TOKEN: "test-token" };

  it("sends through Meta when both credentials are set, in production or not", () => {
    expect(chooseSender({ ...keys, NODE_ENV: "production" })).toMatchObject({ kind: "meta" });
    expect(chooseSender({ ...keys, NODE_ENV: "development" })).toMatchObject({ kind: "meta" });
  });

  it("prints to the console when they are unset outside production", () => {
    expect(chooseSender({ NODE_ENV: "development" })).toMatchObject({ kind: "console" });
    expect(chooseSender({})).toMatchObject({ kind: "console" });
  });

  it("holds in production when either is unset, naming what is missing", () => {
    expect(chooseSender({ NODE_ENV: "production" })).toEqual({
      kind: "hold",
      missing: ["WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_ACCESS_TOKEN"],
    });
    expect(chooseSender({ WHATSAPP_PHONE_NUMBER_ID: "1", VERCEL_ENV: "production" })).toEqual({
      kind: "hold",
      missing: ["WHATSAPP_ACCESS_TOKEN"],
    });
  });

  it("never falls back to the console with only one credential set outside production either: that is a half-made setup, so it holds", () => {
    expect(chooseSender({ WHATSAPP_ACCESS_TOKEN: "t", NODE_ENV: "development" })).toEqual({
      kind: "hold",
      missing: ["WHATSAPP_PHONE_NUMBER_ID"],
    });
  });
});
