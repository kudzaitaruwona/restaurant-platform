import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DashboardError from "./dashboard/error";
import DashboardForbidden from "./dashboard/forbidden";
import DashboardNotFound from "./dashboard/not-found";
import RootError from "./error";
import Forbidden from "./forbidden";
import GlobalError from "./global-error";
import Unauthorized from "./unauthorized";

const at = vi.hoisted(() => ({ path: "/dashboard", search: "" }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => at.path,
  useSearchParams: () => new URLSearchParams(at.search),
}));

beforeEach(() => {
  at.path = "/dashboard";
  at.search = "";
});

const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map(([, href]) => href);

describe("signed out", () => {
  it("signs in and comes back to a deep link", () => {
    at.path = "/dashboard/bookings";
    at.search = "date=2026-11-25";
    expect(hrefs(renderToStaticMarkup(<Unauthorized />))).toEqual([
      "/login?next=%2Fdashboard%2Fbookings%3Fdate%3D2026-11-25",
      "/login/admin",
    ]);
  });

  it("makes the admin sign-in the main way in on /admin", () => {
    at.path = "/admin";
    expect(hrefs(renderToStaticMarkup(<Unauthorized />))).toEqual(["/login/admin", "/login"]);
  });
});

describe("refused", () => {
  it("says who to ask and leads back into the app, from an owner-only page", () => {
    const html = renderToStaticMarkup(<DashboardForbidden />);
    expect(html).toContain("Ask an owner of your restaurant");
    expect(hrefs(html)).toEqual(["/dashboard"]);
  });

  it("leads restaurant staff on /admin back to their dashboard", () => {
    at.path = "/admin";
    expect(hrefs(renderToStaticMarkup(<Forbidden />))).toEqual(["/dashboard"]);
  });

  it("leads a platform admin outside any restaurant to the console", () => {
    expect(hrefs(renderToStaticMarkup(<Forbidden />))).toEqual(["/admin"]);
  });

  it("leads home from a dashboard 404", () => {
    expect(hrefs(renderToStaticMarkup(<DashboardNotFound />))).toEqual(["/dashboard"]);
  });
});

describe("an error boundary", () => {
  it.each([
    ["root", RootError],
    ["dashboard", DashboardError],
    ["global", GlobalError],
  ])("offers a retry, and none of the error's own words: %s", (_name, Boundary) => {
    const retry = vi.fn();
    const error = Object.assign(new Error("secret detail"), { digest: "d1g3st" });
    const html = renderToStaticMarkup(<Boundary error={error} retry={retry} />);
    expect(html).toContain("Try again");
    expect(html).toContain("d1g3st");
    expect(html).not.toContain("secret detail");
    // The button calls the boundary's own retry.
    const page = Boundary({ error, retry });
    expect(JSON.stringify(page, (_key, value) => (value === retry ? "RETRY" : value))).toContain("RETRY");
  });

  it("doesn't assume what was thrown is an Error", () => {
    expect(renderToStaticMarkup(<RootError error="oops" retry={() => {}} />)).not.toContain("oops");
  });
});

describe("page titles", () => {
  it("are there and distinct on every staff and sign-in page", () => {
    const pages = ["dashboard", "admin", "login"].flatMap((area) =>
      readdirSync(join(__dirname, area), { recursive: true, encoding: "utf8" })
        .filter((file) => /(^|[\\/])page\.tsx$/.test(file))
        .map((file) => join(area, file)),
    );
    const titles = pages.map((file) => {
      const [, title] = /export const metadata: Metadata = \{ title: "([^"]+)" \}/.exec(
        readFileSync(join(__dirname, file), "utf8"),
      ) ?? [undefined, `NO TITLE: ${file}`];
      return title;
    });
    expect(titles.filter((title) => title.startsWith("NO TITLE"))).toEqual([]);
    expect(new Set(titles).size).toBe(titles.length);
  });
});

describe("the landing page", () => {
  it("is for a restaurant owner: no developer text or repository link", async () => {
    vi.doMock("@/lib/tenant", () => ({ signedInHome: async () => undefined }));
    const { default: Home } = await import("./page");
    const { StartLink, StaffSignIn } = await import("./start-link");
    // The shell, before anyone is known; a static render can't wait for StartLink.
    const html = renderToStaticMarkup(Home().props.children);
    expect(html).not.toMatch(/github|project/i);
    expect(renderToStaticMarkup(<StaffSignIn />)).toContain('href="/login"');
    expect(renderToStaticMarkup(await StartLink())).toContain('href="/login"');
  });

  it.each(["/dashboard", "/admin"] as const)("offers someone signed in the way to %s", async (home) => {
    vi.resetModules();
    vi.doMock("@/lib/tenant", () => ({ signedInHome: async () => home }));
    const { StartLink } = await import("./start-link");
    expect(renderToStaticMarkup(await StartLink())).toContain(`href="${home}"`);
  });
});
