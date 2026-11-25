import { describe, expect, it } from "vitest";
import { returnPath, signInHref } from "./return-to";

describe("where sign-in may return to", () => {
  it.each([
    "/dashboard",
    "/dashboard/bookings",
    "/dashboard/bookings?date=2026-11-25&new=1",
    "/dashboard/floor/3f1c9a52-0d0a-4b6e-9a55-2f1c0c1d2e3f",
    "/dashboard/bookings/new?name=Tino%20M&phone=%2B263771234567",
  ])("takes a staff page: %s", (path) => {
    expect(returnPath(path, "staff")).toBe(path);
  });

  it("takes an admin page for the admin session", () => {
    expect(returnPath("/admin", "admin")).toBe("/admin");
    expect(returnPath("/admin?tab=x", "admin")).toBe("/admin?tab=x");
  });

  it("never crosses the session types", () => {
    expect(returnPath("/admin", "staff")).toBeUndefined();
    expect(returnPath("/dashboard", "admin")).toBeUndefined();
  });

  it.each([
    "https://evil.example.test/dashboard",
    "//evil.example.test/dashboard",
    "///evil.example.test",
    "/\\evil.example.test",
    "\\/evil.example.test",
    "/dashboard\\..\\api",
    "/%2fevil.example.test",
    "/%5cevil.example.test",
    "/dashboard//evil.example.test",
    "/dashboard/../api/auth/staff/sign-out",
    "/dashboard/%2e%2e/api/staff",
    "/dashboard/%252e%252e/api/staff",
    "/dashboard/.%2e/admin",
    "/dashboard/%2f%2fevil.example.test",
    "/dashboard/%00",
    "/\t/evil.example.test",
    "/dashboard\n",
    "/dashboard\r\nLocation: https://evil.example.test",
    "/dashboard?x=%0d%0aSet-Cookie:a",
    "/dashboard?x=%00",
    "/dashboard?x=%5cevil",
    "/dashboard?x=%250d",
    "/dashboard?x=%E0%A4%A",
    "/dashboard?x=\\evil",
    "/dashboard?next=//evil.example.test",
    "/dashboard?next=%2f%2fevil.example.test",
    "/dashboard#x",
    "/dashboard@evil.example.test",
    "/dashboard.evil",
    "/dashboardx",
    "/Dashboard",
    " /dashboard",
    "dashboard",
    "javascript:alert(1)",
    "/",
    "/api/staff",
    "/login",
    "/m/token",
    "/∕/evil.example.test",
    "",
    `/dashboard?x=${"a".repeat(600)}`,
    undefined,
    null,
    ["/dashboard"],
    42,
  ])("refuses %j", (value) => {
    expect(returnPath(value, "staff")).toBeUndefined();
    expect(returnPath(value, "admin")).toBeUndefined();
  });
});

describe("the sign-in link on a signed-out page", () => {
  it("keeps a deep link, with its query", () => {
    expect(signInHref("/dashboard/bookings", "date=2026-11-25")).toBe(
      "/login?next=%2Fdashboard%2Fbookings%3Fdate%3D2026-11-25",
    );
  });

  it("leaves out what sign-in would do anyway", () => {
    expect(signInHref("/dashboard", "")).toBe("/login");
    expect(signInHref("/admin", "")).toBe("/login/admin");
  });

  it("is the admin's on an admin page", () => {
    expect(signInHref("/admin", "x=1")).toBe("/login/admin?next=%2Fadmin%3Fx%3D1");
  });

  it("drops a query it wouldn't take, and a path it can't return to", () => {
    expect(signInHref("/dashboard/menu", "x=%00")).toBe("/login?next=%2Fdashboard%2Fmenu");
    expect(signInHref("/elsewhere", "")).toBe("/login");
    expect(signInHref(null, "")).toBe("/login");
  });
});
