import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SettingsForm } from "./settings-form";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }) }));

const html = renderToStaticMarkup(
  <SettingsForm
    saved={{
      name: "Mama's Kitchen",
      contactPhone: "",
      wifiName: "",
      wifiPassword: "",
      currencyMode: "usd_only",
      timezone: "Africa/Harare",
    }}
    currencies={[{ value: "usd_only", label: "USD only" }]}
    zones={["Africa/Harare", "UTC"]}
  />,
);

describe("the settings form", () => {
  it("has no disabled fieldset, which would drop the focus of whoever pressed Save", () => {
    expect(html).toMatch(/<fieldset(?![^>]*disabled)/);
    expect(html).not.toMatch(/ disabled[ =>]/);
  });

  it("offers each timezone once, the saved one chosen", () => {
    expect(html.match(/<option value="Africa\/Harare"/g)).toHaveLength(1);
    expect(html).toContain('<option value="UTC"');
  });
});
