import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FORM_FETCH_HEADER } from "./lib/form-response";
import { config, proxy } from "./proxy";

const request = (
  path: string,
  init: { method?: string; headers?: Record<string, string> } = {},
) =>
  new NextRequest(new URL(path, "http://app.example.test"), {
    ...init,
    headers: { host: "app.example.test", ...init.headers },
  });

afterEach(() => vi.unstubAllEnvs());

describe("the matcher", () => {
  it.each([
    "/dashboard",
    "/dashboard/settings",
    "/dashboard/staff",
    "/admin",
  ])("covers the staff and admin page %s", (url) => {
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(true);
  });

  it.each(["/", "/login", "/login/admin", "/r/restaurant-a"])("leaves %s alone", (url) => {
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(false);
  });

  it("covers the public menu page, for its cache (S-32)", () => {
    expect(unstable_doesMiddlewareMatch({ config, url: "/m/a-menu-token" })).toBe(true);
  });

  it("covers a table's QR page too, for the same cache", () => {
    expect(unstable_doesMiddlewareMatch({ config, url: "/t/a-qr-token" })).toBe(true);
  });
});

describe("the public pages' cache (S-32)", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "PROPFIND"])(
    "refuses %s, which Next.js would store as the page",
    (method) => {
      const response = proxy(request("/m/a-menu-token", { method }));
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD");
    },
  );

  it.each(["GET", "HEAD"])("lets %s through to the cache", (method) => {
    const response = proxy(request("/m/a-menu-token", { method }));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "PROPFIND"])(
    "refuses %s to a table's QR page too",
    (method) => {
      const response = proxy(request("/t/a-qr-token", { method }));
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD");
    },
  );

  it("does no session work, even for someone with a staff cookie", () => {
    const response = proxy(
      request("/m/a-menu-token", { headers: { cookie: "staff.session_token=token" } }),
    );
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

describe("a guest's manage link", () => {
  it("is covered by the matcher, for the cross-site check", () => {
    expect(unstable_doesMiddlewareMatch({ config, url: "/b/a-manage-token" })).toBe(true);
  });

  it("takes a POST, which the cached pages refuse", () => {
    expect(proxy(request("/b/a-manage-token", { method: "POST" })).status).toBe(200);
  });

  it("refuses a cancel posted from another site", () => {
    const response = proxy(
      request("/b/a-manage-token", {
        method: "POST",
        headers: { origin: "https://evil.example.test" },
      }),
    );
    expect(response.status).toBe(403);
  });

  it("allows its own form's post", () => {
    const response = proxy(
      request("/b/a-manage-token", {
        method: "POST",
        headers: { origin: "http://app.example.test" },
      }),
    );
    expect(response.status).toBe(200);
  });

  it("does no session work, even for someone with a staff cookie", () => {
    const response = proxy(
      request("/b/a-manage-token", { headers: { cookie: "staff.session_token=token" } }),
    );
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

describe("cross-site writes (S-30)", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE"])("refuses a cross-site %s", (method) => {
    const response = proxy(
      request("/api/staff/1", {
        method,
        headers: { origin: "https://evil.example.test" },
      }),
    );
    expect(response.status).toBe(403);
  });

  it.each([
    "/api/restaurant",
    "/api/staff",
    "/api/staff/1/deactivate",
    "/api/staff/1/role",
    "/api/admin/restaurants",
    "/api/admin/restaurants/1/owner",
  ])("refuses a cross-site write to %s, and the matcher sends it here", (path) => {
    expect(unstable_doesMiddlewareMatch({ config, url: path })).toBe(true);
    const response = proxy(
      request(path, { method: "POST", headers: { origin: "https://evil.example.test" } }),
    );
    expect(response.status).toBe(403);
  });

  it("isn't talked out of it by the header ActionForm sends", () => {
    const response = proxy(
      request("/api/staff", {
        method: "POST",
        headers: { origin: "https://evil.example.test", [FORM_FETCH_HEADER]: "1" },
      }),
    );
    expect(response.status).toBe(403);
  });

  it("lets ActionForm's own post through", () => {
    const response = proxy(
      request("/api/staff", {
        method: "POST",
        headers: { origin: "http://app.example.test", [FORM_FETCH_HEADER]: "1" },
      }),
    );
    expect(response.status).toBe(200);
  });

  it("refuses a sibling subdomain, which SameSite doesn't stop", () => {
    const response = proxy(
      request("/api/staff/1", {
        method: "POST",
        headers: { origin: "https://images.example.test" },
      }),
    );
    expect(response.status).toBe(403);
  });

  it("refuses an opaque origin", () => {
    const response = proxy(
      request("/api/staff/1", { method: "POST", headers: { origin: "null" } }),
    );
    expect(response.status).toBe(403);
  });

  it("allows a same-origin form post", () => {
    const response = proxy(
      request("/api/staff/1", {
        method: "POST",
        headers: { origin: "http://app.example.test" },
      }),
    );
    expect(response.status).toBe(200);
  });

  it("honours the host a proxy in front of us forwarded", () => {
    const response = proxy(
      request("/api/staff/1", {
        method: "POST",
        headers: {
          host: "internal.vercel.test",
          "x-forwarded-host": "app.example.test",
          origin: "https://app.example.test",
        },
      }),
    );
    expect(response.status).toBe(200);
  });

  it("allows a server-to-server call, which has no Origin: the Meta webhook", () => {
    expect(proxy(request("/api/webhook", { method: "POST" })).status).toBe(200);
  });

  it("leaves reads alone, wherever they came from", () => {
    const response = proxy(
      request("/api/auth/staff/magic-link/verify?token=x", {
        headers: { origin: "https://mail.example.test" },
      }),
    );
    expect(response.status).toBe(200);
  });
});

describe("the session cookie (30 days idle, spec 01)", () => {
  const withCookie = (path: string, name: string) =>
    proxy(request(path, { headers: { cookie: `${name}=token.signature%3D` } }));

  it("is pushed out by each use, because pages can't set cookies themselves", () => {
    const [cookie] = withCookie("/dashboard", "staff.session_token").headers.getSetCookie();
    expect(cookie).toMatch(/^staff\.session_token=token\.signature%3D;/);
    expect(cookie).toMatch(/Max-Age=2592000/i);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Path=\//i);
  });

  it("does the same for the admin session", () => {
    const [cookie] = withCookie("/admin", "admin.session_token").headers.getSetCookie();
    expect(cookie).toMatch(/^admin\.session_token=/);
  });

  it("is Secure, under its production name, in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const [cookie] = withCookie(
      "/dashboard",
      "__Secure-staff.session_token",
    ).headers.getSetCookie();
    expect(cookie).toMatch(/^__Secure-staff\.session_token=/);
    expect(cookie).toMatch(/; Secure/i);
  });

  it("is never set on someone who has none", () => {
    expect(proxy(request("/dashboard")).headers.getSetCookie()).toEqual([]);
  });

  it("stays out of the way of sign-out, which deletes it", () => {
    const response = withCookie("/api/auth/staff/sign-out", "staff.session_token");
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});
