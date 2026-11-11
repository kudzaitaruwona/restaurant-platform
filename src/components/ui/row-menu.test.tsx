import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { menuPosition, nextMenuIndex, RowMenu, RowMenuItem, RowMenuLabel, RowMenuSeparator } from "./row-menu";

vi.mock("next/link", () => ({
  default: ({ href, ...props }: { href: string }) => <a href={href} {...props} />,
}));

const html = renderToStaticMarkup(
  <RowMenu label="More for Blessing Moyo">
    <RowMenuLabel>19:00, T6</RowMenuLabel>
    <RowMenuItem href="/dashboard/bookings/new">Edit</RowMenuItem>
    <RowMenuItem disabled hint="No other table is free">
      Move to another table
    </RowMenuItem>
    <RowMenuSeparator />
    <RowMenuItem tone="danger" form="cancel-b1">
      Cancel booking
    </RowMenuItem>
  </RowMenu>,
);

describe("the row menu", () => {
  it("is a named button that opens a native popover menu, so it opens even before scripts load", () => {
    const trigger = /<button[^>]*popoverTarget="[^"]*"[^>]*>|<button[^>]*popovertarget="[^"]*"[^>]*>/i.exec(html)?.[0] ?? "";
    expect(trigger).toContain('aria-haspopup="menu"');
    expect(trigger).toContain('aria-label="More for Blessing Moyo"');
    const target = /popovertarget="([^"]+)"/i.exec(trigger)?.[1];
    expect(html).toMatch(new RegExp(`<div[^>]*id="${target}"[^>]*popover="auto"[^>]*role="menu"`));
  });

  it("submits a form elsewhere on the page, so a server component can wire an item to an ActionForm", () => {
    expect(html).toMatch(/<button role="menuitem" type="submit" form="cancel-b1"[^>]*class="[^"]*text-danger/);
  });

  it("puts a hairline before the destructive items", () => {
    expect(html.indexOf('role="separator"')).toBeLessThan(html.indexOf("Cancel booking"));
    expect(html.indexOf('role="separator"')).toBeGreaterThan(html.indexOf("Move to another table"));
  });

  it("shows a disabled item with why, and doesn't make it a link or a submit", () => {
    expect(html).toMatch(/<button role="menuitem" type="button" aria-disabled="true"[^>]*>.*Move to another table.*No other table is free/);
  });

  it("links an item with an href", () => {
    expect(html).toMatch(/<a href="\/dashboard\/bookings\/new" role="menuitem"/);
  });
});

describe("moving through the menu", () => {
  it.each([
    [-1, "ArrowDown", 0],
    [-1, "ArrowUp", 2],
    [0, "ArrowDown", 1],
    [2, "ArrowDown", 0],
    [0, "ArrowUp", 2],
    [1, "Home", 0],
    [1, "End", 2],
  ])("from %i, %s goes to %i of three", (current, key, next) => {
    expect(nextMenuIndex(current, 3, key)).toBe(next);
  });

  it("leaves other keys alone, and an empty menu", () => {
    expect(nextMenuIndex(0, 3, "Enter")).toBeUndefined();
    expect(nextMenuIndex(-1, 0, "ArrowDown")).toBeUndefined();
  });
});

describe("where the menu opens", () => {
  const viewport = { width: 1180, height: 820 };
  const menu = { width: 240, height: 160 };

  it("opens under the trigger, lined up with its end", () => {
    const anchor = { top: 100, bottom: 148, left: 900, right: 948 };
    expect(menuPosition(anchor, menu, viewport, "end")).toEqual({ top: 152, left: 708 });
  });

  it("lines up with its start when asked", () => {
    const anchor = { top: 100, bottom: 148, left: 300, right: 348 };
    expect(menuPosition(anchor, menu, viewport, "start").left).toBe(300);
  });

  it("opens above when there's no room below", () => {
    const anchor = { top: 740, bottom: 788, left: 900, right: 948 };
    expect(menuPosition(anchor, menu, viewport, "end").top).toBe(740 - 4 - 160);
  });

  it("stays on screen at the edges", () => {
    const anchor = { top: 100, bottom: 148, left: 4, right: 52 };
    expect(menuPosition(anchor, menu, viewport, "end").left).toBe(8);
    const right = { top: 100, bottom: 148, left: 1150, right: 1198 };
    expect(menuPosition(right, menu, viewport, "start").left).toBe(1180 - 240 - 8);
  });
});
