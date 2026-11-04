import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { devSwitcherIdentities } from "@/lib/tenant/dev-identities";

async function render() {
  vi.resetModules(); // fresh env cache per test
  const { DevSwitcher } = await import("./dev-switcher");
  return renderToStaticMarkup(<DevSwitcher />);
}

describe("DevSwitcher", () => {
  beforeEach(() => {
    vi.stubEnv(
      "DATABASE_URL",
      "postgres://app_tenant:app_tenant@localhost:5499/restaurant_dev",
    );
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
    vi.stubEnv("R2_ACCOUNT_ID", "account");
    vi.stubEnv("R2_ACCESS_KEY_ID", "key");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "secret");
    vi.stubEnv("R2_BUCKET", "photos");
    vi.stubEnv("R2_PUBLIC_BASE_URL", "https://images.example.test");
    vi.stubEnv("DEV_AUTH_BYPASS", "1");
    vi.stubEnv("NEON_WS_PROXY", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("offers every seeded identity, platform admin included, when the bypass is on", async () => {
    const html = await render();
    expect(devSwitcherIdentities).toHaveLength(5);
    for (const identity of devSwitcherIdentities) {
      expect(html).toContain(identity.label);
      expect(html).toContain(`value="${identity.key}"`);
    }
  });

  it("renders nothing without the bypass", async () => {
    vi.stubEnv("DEV_AUTH_BYPASS", "");
    expect(await render()).toBe("");
  });

  it("renders nothing in production, even with the variable set", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(await render()).toBe("");
  });
});
