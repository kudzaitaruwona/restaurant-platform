import { describe, expect, it } from "vitest";
import {
  clientIp,
  declaredLength,
  ipBucket,
  limitKey,
  MAX_BODY_BYTES,
  readFormWithin,
} from "./booking-limits";

const headers = (init: Record<string, string>) => new Headers(init);
const onVercel = { onVercel: true, production: true };
const production = { onVercel: false, production: true };
const development = { onVercel: false, production: false };

describe("the guest's address", () => {
  it("on Vercel is x-vercel-forwarded-for, and nothing the client could have written", () => {
    expect(
      clientIp(
        headers({ "x-vercel-forwarded-for": "203.0.113.7", "x-forwarded-for": "198.51.100.1" }),
        onVercel,
      ),
    ).toBe("203.0.113.7");
    expect(clientIp(headers({ "x-forwarded-for": "198.51.100.1" }), onVercel)).toBeUndefined();
  });

  it("in production off Vercel is nobody's, because every header is the client's word", () => {
    expect(
      clientIp(
        headers({ "x-forwarded-for": "198.51.100.1", "x-vercel-forwarded-for": "203.0.113.7" }),
        production,
      ),
    ).toBeUndefined();
  });

  it("in development reads x-forwarded-for, the first one", () => {
    expect(clientIp(headers({ "x-forwarded-for": "198.51.100.1, 10.0.0.1" }), development)).toBe(
      "198.51.100.1",
    );
  });

  it.each(["", "not an ip", "999.1.1.1", "1.2.3.4:80", "<script>"])(
    "ignores %j, which isn't an address",
    (value) => {
      expect(clientIp(headers({ "x-vercel-forwarded-for": value }), onVercel)).toBeUndefined();
    },
  );
});

describe("what counts as one visitor", () => {
  it("is an IPv4 address itself", () => {
    expect(ipBucket("203.0.113.7")).toBe("203.0.113.7");
  });

  it("is an IPv6 address's /64, however it is written", () => {
    const same = [
      "2001:db8:1:2:3:4:5:6",
      "2001:DB8:1:2:ffff:ffff:ffff:ffff",
      "2001:db8:1:2::",
      "2001:0db8:0001:0002::1",
    ];
    expect(new Set(same.map(ipBucket)).size).toBe(1);
    expect(ipBucket("2001:db8:1:3::1")).not.toBe(ipBucket("2001:db8:1:2::1"));
  });

  it("is the IPv4 inside an IPv4-mapped IPv6 address", () => {
    expect(ipBucket("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(ipBucket("::ffff:cb00:7107")).toBe("203.0.113.7");
  });

  it("copes with the shortest forms", () => {
    expect(ipBucket("::1")).toBe("0000:0000:0000:0000::/64");
    expect(ipBucket("::")).toBe("0000:0000:0000:0000::/64");
  });
});

describe("the stored key", () => {
  it("is a hash that holds no part of the address", () => {
    const key = limitKey("203.0.113.7", "secret");
    expect(key).not.toContain("203");
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("differs by address and by secret, and is stable otherwise", () => {
    expect(limitKey("203.0.113.7", "a")).toBe(limitKey("203.0.113.7", "a"));
    expect(limitKey("203.0.113.7", "a")).not.toBe(limitKey("203.0.113.8", "a"));
    expect(limitKey("203.0.113.7", "a")).not.toBe(limitKey("203.0.113.7", "b"));
  });

  it("gives everyone without an address one key of their own", () => {
    expect(limitKey(undefined, "a")).toBe(limitKey(undefined, "a"));
    expect(limitKey(undefined, "a")).not.toBe(limitKey("unknown", "a"));
  });
});

describe("the declared length", () => {
  it("is the number, none when absent, and invalid for anything else", () => {
    expect(declaredLength(headers({ "content-length": "120" }))).toBe(120);
    expect(declaredLength(headers({}))).toBeUndefined();
    for (const value of ["-1", "1e3", "abc", "", "9".repeat(30)]) {
      expect(declaredLength(headers({ "content-length": value }))).toBe("invalid");
    }
  });
});

describe("reading the body within a limit", () => {
  const post = (body: BodyInit, type?: string) =>
    new Request("http://localhost/x", {
      method: "POST",
      body,
      headers: type ? { "content-type": type } : undefined,
    });

  it("reads a form", async () => {
    const form = new FormData();
    form.set("name", "Tariro");
    const read = await readFormWithin(post(form));
    expect(read).toBeInstanceOf(FormData);
    expect((read as FormData).get("name")).toBe("Tariro");
  });

  it("stops at the limit, for a body that never said how long it was", async () => {
    // A stream has no Content-Length, so only reading it can show its size.
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1024;
        controller.enqueue(new Uint8Array(1024));
        if (pulled > 1024 * 1024) controller.close();
      },
    });
    const request = new Request("http://localhost/x", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit);

    expect(await readFormWithin(request)).toBe("too_large");
    expect(pulled).toBeLessThan(MAX_BODY_BYTES * 3);
  });

  it("accepts a body of exactly the limit and refuses one a byte over", async () => {
    const exact = await readFormWithin(post("x".repeat(MAX_BODY_BYTES), "text/plain"));
    const over = await readFormWithin(post("x".repeat(MAX_BODY_BYTES + 1), "text/plain"));
    expect(exact).toBeInstanceOf(FormData);
    expect(over).toBe("too_large");
  });

  it("takes something that isn't a form for an empty one", async () => {
    const read = await readFormWithin(post("{}", "application/json"));
    expect([...(read as FormData)]).toEqual([]);
  });
});
