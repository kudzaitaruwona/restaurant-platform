import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home from "@/app/page";
import { Button, buttonVariants } from "./button";

describe("shadcn/ui Button", () => {
  it("renders a styled button", () => {
    const html = renderToStaticMarkup(<Button variant="outline">Save</Button>);
    expect(html).toMatch(/^<button[^>]*data-slot="button"/);
    expect(html).toContain("Save");
    expect(html).toMatch(/class="[^"]*border-line/);
  });

  it("lets a className override the variant's own classes when styling a link", () => {
    const classes = buttonVariants({ variant: "secondary", className: "hidden" }).split(" ");
    expect(classes).toContain("hidden");
    expect(classes).not.toContain("inline-flex");
    expect(classes).toContain("border-line");
  });

  it("is rendered on the home page", () => {
    const html = renderToStaticMarkup(<Home />);
    expect(html).toContain(`data-slot="button"`);
  });
});
