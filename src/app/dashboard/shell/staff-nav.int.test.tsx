import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { testDatabaseSettings } from "../../../../test/integration/database";
import { statusOf } from "../../../../test/integration/http";

/** The staff rail on every /dashboard page (S-41), for the dev identities. */
const session = vi.hoisted(() => ({ identity: "", path: "/dashboard" }));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => ({ name, value: session.identity }),
  }),
}));

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => session.path,
  useRouter: () => ({ replace() {}, refresh() {} }),
}));

async function staffNav() {
  vi.resetModules(); // fresh env cache per test
  const { StaffNav } = await import("./staff-shell");
  return StaffNav;
}

async function render(identity: string, path = "/dashboard") {
  session.identity = identity;
  session.path = path;
  const StaffNav = await staffNav();
  return renderToStaticMarkup(await StaffNav());
}

describe("the staff rail", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
    vi.stubEnv("DEV_AUTH_BYPASS", "1");
  });
  afterAll(() => vi.unstubAllEnvs());

  it("names the current restaurant and who is signed in, and no other restaurant", async () => {
    // The dev switcher lists every seeded identity by design; leave it out.
    const html = (await render("b-staff")).replace(/<details[\s\S]*?<\/details>/g, "");
    expect(html).toContain("Restaurant B");
    expect(html).toContain("Restaurant B staff");
    expect(html).toContain(">Staff</span>");
    expect(html).not.toContain("Restaurant A");
  });

  it("links an owner to the owner-only screens, and not staff", async () => {
    const owner = await render("a-owner");
    for (const href of [
      "/dashboard/staff",
      "/dashboard/settings",
      "/dashboard/menu",
      "/dashboard/tables",
      "/dashboard/bookings",
      "/dashboard/bookings/settings",
    ]) {
      expect(owner).toContain(`href="${href}"`);
    }
    const staff = await render("a-staff");
    expect(staff).not.toContain("/dashboard/staff");
    expect(staff).not.toContain("/dashboard/settings");
    expect(staff).not.toContain("/dashboard/tables");
    expect(staff).not.toContain("/dashboard/bookings/settings");
    expect(staff).toContain('href="/dashboard/menu"');
    expect(staff).toContain('href="/dashboard/bookings"');
  });

  it("links owner and staff alike to the floor and the kitchen (S-26)", async () => {
    for (const identity of ["a-owner", "a-staff"]) {
      const html = await render(identity);
      expect(html).toContain('href="/dashboard/floor"');
      expect(html).toContain('href="/dashboard/kitchen"');
    }
  });

  it("marks the page you're on, in the rail and the phone drawer", async () => {
    const html = await render("a-owner", "/dashboard/bookings/new");
    const current = html.match(/<a [^>]*aria-current="page"[^>]*>/g) ?? [];
    expect(current).toHaveLength(2);
    for (const link of current) expect(link).toContain('href="/dashboard/bookings"');
  });

  it("shows an owner the exchange rate and where to change it, and staff neither", async () => {
    expect(await render("a-owner")).toMatch(/aria-label="(Exchange rate 1 USD = ZiG|No exchange rate is set)[^"]*Menu page\."/);
    expect(await render("a-staff")).not.toMatch(/ZiG|exchange rate/i);
  });

  it("puts the dev switcher in sign-out's slot, marking who you are now", async () => {
    const html = await render("a-staff");
    expect(html).toContain('action="/api/dev/identity"');
    expect(html).toMatch(/value="a-staff" aria-current="true"/);
    expect(html).not.toMatch(/value="a-owner" aria-current/);
  });

  it("refuses no identity with unauthorized(), before any data renders", async () => {
    vi.stubEnv("DEV_AUTH_BYPASS", "");
    const StaffNav = await staffNav();
    expect(await statusOf(() => StaffNav())).toBe(401);
  });
});
