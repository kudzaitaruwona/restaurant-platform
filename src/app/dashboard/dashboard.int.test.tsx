import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { testDatabaseSettings } from "../../../test/integration/database";
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

  it("is a 401 with no identity", async () => {
    vi.stubEnv("DEV_AUTH_BYPASS", "");
    const Dashboard = await dashboard();
    expect(await statusOf(() => Dashboard())).toBe(401);
  });
});
