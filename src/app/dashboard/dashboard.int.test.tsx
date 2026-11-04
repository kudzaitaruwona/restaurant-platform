import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { staff } from "@/db/schema";
import {
  openOwnerDatabase,
  testDatabaseSettings,
} from "../../../test/integration/database";
import { statusOf } from "../../../test/integration/http";

const session = vi.hoisted(() => ({ identity: "" }));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => ({ name, value: session.identity }),
  }),
}));

async function dashboard() {
  vi.resetModules(); // fresh env cache per test
  const { Dashboard } = await import("./dashboard");
  return Dashboard;
}

async function render(identity: string) {
  session.identity = identity;
  const Dashboard = await dashboard();
  return renderToStaticMarkup(await Dashboard());
}

describe("the protected page", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
    vi.stubEnv("DEV_AUTH_BYPASS", "1");
  });
  afterAll(() => vi.unstubAllEnvs());

  it("shows the current restaurant and who you are", async () => {
    const html = await render("b-staff");
    expect(html).toContain("Restaurant B");
    expect(html).toContain("Restaurant B staff");
    expect(html).toContain("staff");
  });

  it("never shows another restaurant's people", async () => {
    expect(await render("a-owner")).not.toContain("Restaurant B");
    expect(await render("b-owner")).not.toContain("Restaurant A");
  });

  it("offers an owner the rename action", async () => {
    expect(await render("a-owner")).toContain('method="post"');
  });

  it("doesn't offer it to staff", async () => {
    expect(await render("a-staff")).not.toContain('method="post"');
  });

  it("leaves the admin's shadow row out of the team, and offers no rename for it", async () => {
    const owner = openOwnerDatabase();
    // Left behind: another file may be inside this restaurant through this row.
    await owner.db
      .insert(staff)
      .values({
        restaurantId: "00000000-0000-4000-8000-00000000000a",
        kind: "platform_admin",
        role: "owner",
        displayName: "Platform admin",
      })
      .onConflictDoNothing();
    try {
      expect(await render("a-owner")).not.toContain("Platform admin");
    } finally {
      await owner.pool.end();
    }
  });

  it("leaves deactivated colleagues out of the team", async () => {
    const id = crypto.randomUUID();
    const owner = openOwnerDatabase();
    await owner.db.insert(staff).values({
      id,
      restaurantId: "00000000-0000-4000-8000-00000000000a",
      email: `${id}@example.test`,
      displayName: "Long gone",
      active: false,
    });
    try {
      expect(await render("a-owner")).not.toContain("Long gone");
    } finally {
      await owner.db.delete(staff).where(eq(staff.id, id));
      await owner.pool.end();
    }
  });

  it("links an owner to the owner-only screens, and not staff", async () => {
    expect(await render("a-owner")).toContain('href="/dashboard/staff"');
    expect(await render("a-owner")).toContain('href="/dashboard/settings"');
    expect(await render("a-owner")).toContain('href="/dashboard/menu"');
    expect(await render("a-owner")).toContain('href="/dashboard/tables"');
    expect(await render("a-staff")).not.toContain("/dashboard/staff");
    expect(await render("a-staff")).not.toContain("/dashboard/settings");
    expect(await render("a-staff")).not.toContain("/dashboard/tables");
    expect(await render("a-staff")).toContain('href="/dashboard/menu"');
  });

  it("refuses no identity with unauthorized(), before any data renders", async () => {
    vi.stubEnv("DEV_AUTH_BYPASS", "");
    const Dashboard = await dashboard();
    expect(await statusOf(() => Dashboard())).toBe(401);
  });
});
