import { type ReactElement, Suspense } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import AdminPage from "./admin/page";
import DashboardLayout from "./dashboard/layout";
import { announceSend } from "./dashboard/refusals";
import { PageRefresh, SavedPlace, clearWithSends } from "./page-refresh";

vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh() {} }),
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(),
}));

/** Whether an element's tree, as written, has a PageRefresh around something. */
function hasPageRefresh(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasPageRefresh);
  const element = node as ReactElement<{ children?: unknown }> | null;
  if (typeof element !== "object" || !element?.props) return false;
  if (element.type === PageRefresh) return Boolean(element.props.children);
  return hasPageRefresh(element.props.children);
}

describe("the place for what a save says once its form is gone (#111)", () => {
  it("is around every dashboard page and the admin console, so each form on them shares it", () => {
    expect(hasPageRefresh(DashboardLayout({ children: "page" }))).toBe(true);
    expect(hasPageRefresh(AdminPage())).toBe(true);
  });

  it("is a status region from the start, empty and taking no room, so that what it says later is announced", () => {
    for (const html of [
      renderToStaticMarkup(<SavedPlace>form</SavedPlace>),
      renderToStaticMarkup(<Suspense><PageRefresh>form</PageRefresh></Suspense>),
    ]) {
      expect(html).toMatch(/<div role="status" class="sr-only"><\/div>/);
      expect(html).toContain("form");
    }
  });

  it("is cleared when any form on the page is sent, but outlives its own form's send", () => {
    let message: string | undefined;
    const stop = clearWithSends(() => (message = undefined));

    announceSend(Symbol("the delete")); // sent, then saved
    message = "Deleted.";
    announceSend(Symbol("another form"));
    expect(message).toBeUndefined();
    stop();
  });

  it("is cleared when the page is left, and listens no longer", () => {
    const clear = vi.fn();
    const stop = clearWithSends(clear);

    stop();
    expect(clear).toHaveBeenCalledTimes(1);
    announceSend(Symbol("another form"));
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
