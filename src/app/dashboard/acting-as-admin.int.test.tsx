import { eq } from "drizzle-orm";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  adminAuthUser,
  platformAdmins,
  restaurants,
  staff,
  staffAuthUser,
} from "@/db/schema";
import { signIn } from "../../../test/integration/auth";
import {
  openOwnerDatabase,
  testDatabaseSettings,
} from "../../../test/integration/database";
import { installFakeServices } from "../../../test/integration/fake-services";
import { statusOf } from "../../../test/integration/http";
import { ActingAsAdminBanner } from "./acting-as-admin-banner";
import { Dashboard } from "./dashboard";
import DashboardLayout from "./layout";
import { SessionControls } from "./session-controls";

/** The staff UI for a platform admin who has entered, on a real session. */
const browser = vi.hoisted(() => ({ cookie: "" }));

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ cookie: browser.cookie }),
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: Promise<unknown>) => task,
}));

const owner = openOwnerDatabase();
const id = crypto.randomUUID();
const adminEmail = `banner-admin-${id}@example.test`;
const ownerEmail = `real-owner-${id}@example.test`;
const restaurantName = `Mama's <Kitchen> ${id}`;

let adminCookie = "";
let staffCookie = "";

beforeAll(async () => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
  vi.stubEnv("DEV_AUTH_BYPASS", "");
  const services = installFakeServices();
  await owner.db.insert(platformAdmins).values({ email: adminEmail });
  await owner.db.insert(restaurants).values({
    id,
    name: restaurantName,
    slug: `banner-${id}`,
    menuToken: `banner-${id}`,
    currencyMode: "usd_only",
  });
  await owner.db.insert(staff).values({
    restaurantId: id,
    email: ownerEmail,
    displayName: "The real owner",
    role: "owner",
  });
  adminCookie = await signIn(services, "admin", adminEmail);
  staffCookie = await signIn(services, "staff", ownerEmail);

  browser.cookie = adminCookie;
  const { enterRestaurant, getPlatformAdminContext } = await import(
    "@/lib/tenant/platform-admin"
  );
  await enterRestaurant(await getPlatformAdminContext(), id);
});

afterAll(async () => {
  await owner.db.delete(staffAuthUser).where(eq(staffAuthUser.email, ownerEmail));
  await owner.db.delete(adminAuthUser).where(eq(adminAuthUser.email, adminEmail));
  await owner.db.delete(platformAdmins).where(eq(platformAdmins.email, adminEmail));
  await owner.pool.end();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const banner = async () => {
  const element = await ActingAsAdminBanner();
  return element ? renderToStaticMarkup(element) : "";
};

describe("the banner", () => {
  it("says whose restaurant the admin is acting in", async () => {
    browser.cookie = adminCookie;
    expect(await banner()).toContain(
      renderToStaticMarkup(<>Acting as admin in {restaurantName}</>),
    );
  });

  it("offers a way out, as a plain post that redirects", async () => {
    browser.cookie = adminCookie;
    const html = await banner();
    expect(html).toContain('action="/api/admin/leave"');
    expect(html).toContain('method="post"');
  });

  it("stays off paper, so it can't print on a sheet or push a row of cards off the page", async () => {
    browser.cookie = adminCookie;
    expect(await banner()).toMatch(/class="[^"]*\bprint:hidden\b/);
  });

  it("isn't there for staff", async () => {
    browser.cookie = staffCookie;
    expect(await banner()).toBe("");
  });

  it("is a refusal, not an empty banner, for nobody", async () => {
    browser.cookie = "";
    expect(await statusOf(() => ActingAsAdminBanner())).toBe(401);
  });
});

describe("the dashboard layout", () => {
  /** Every element under `node`, so a wrapper added later doesn't fail this. */
  const elementsIn = (node: ReactNode): ReactElement<{ children?: ReactNode }>[] =>
    Children.toArray(node)
      .filter((child) => isValidElement<{ children?: ReactNode }>(child))
      .flatMap((child) => [child, ...elementsIn(child.props.children)]);

  it("mounts the banner above every staff page", () => {
    const page = <main />;

    const elements = elementsIn(DashboardLayout({ children: page }));

    const types = elements.map(({ type }) => type);
    expect(types).toContain(ActingAsAdminBanner);
    expect(types.indexOf(ActingAsAdminBanner)).toBeLessThan(types.indexOf("main"));
  });
});

describe("signing out", () => {
  it("ends the admin's session for an admin, not a staff session they don't have", async () => {
    browser.cookie = adminCookie;
    expect((await SessionControls()).props.audience).toBe("admin");
  });

  it("ends the staff session for staff", async () => {
    browser.cookie = staffCookie;
    expect((await SessionControls()).props.audience).toBe("staff");
  });
});

describe("the dashboard, for an admin inside a restaurant", () => {
  it("shows that restaurant's team and owner tools, without the shadow row", async () => {
    browser.cookie = adminCookie;
    const html = renderToStaticMarkup(await Dashboard());

    expect(html).toContain("The real owner");
    expect(html).toContain("/dashboard/settings");
    expect(html).toContain("Signed in as platform admin (owner)");
    expect(html.match(/Platform admin/g)).toBeNull();
  });
});
