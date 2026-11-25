import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

import { NewRestaurantSheet } from "./new-restaurant-sheet";

describe("the New restaurant form (#94)", () => {
  it("keeps the /r/ prefix on one line beside the address input", () => {
    const html = renderToStaticMarkup(
      <NewRestaurantSheet
        timezone="UTC"
        timezones={["UTC"]}
        currencyModes={[{ value: "usd", label: "USD" }]}
        currencyMode="usd"
        appUrl="https://example.test"
      />,
    );
    const prefix = /<span [^>]*class="([^"]*)"[^>]*>\/r\/<\/span>/.exec(html)![1].split(" ");
    expect(prefix).toEqual(expect.arrayContaining(["shrink-0", "whitespace-nowrap"]));
  });
});
