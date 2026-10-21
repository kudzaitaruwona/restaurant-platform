import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home from "@/app/page";
import { Button } from "./button";

describe("shadcn/ui Button", () => {
  it("renders a styled button", () => {
    const html = renderToStaticMarkup(<Button variant="outline">Save</Button>);
    expect(html).toMatch(/^<button[^>]*data-slot="button"/);
    expect(html).toContain("Save");
    expect(html).toMatch(/class="[^"]*border-border/);
  });

  it("is rendered on the home page", () => {
    const html = renderToStaticMarkup(<Home />);
    expect(html).toContain(`data-slot="button"`);
  });
});
