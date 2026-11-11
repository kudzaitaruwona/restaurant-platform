import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type PillStatus, StatusPill } from "./status-pill";

describe("the status pill", () => {
  it.each([
    ["placed", "Placed"],
    ["cooking", "Cooking"],
    ["done", "Done"],
    ["delivered", "Delivered"],
    ["voided", "Voided"],
    ["confirmed", "Confirmed"],
    ["seated", "Seated"],
    ["completed", "Completed"],
    ["cancelled", "Cancelled"],
    ["no_show", "No-show"],
    ["late", "Late"],
  ] as [PillStatus, string][])("says %s in words, not colour alone", (status, word) => {
    const html = renderToStaticMarkup(<StatusPill status={status} />);
    expect(html).toContain(`data-status="${status}"`);
    expect(html).toMatch(new RegExp(`>${word}</span>$`));
  });

  it("uses green for positive states, red for voided and cancelled, amber for late", () => {
    expect(renderToStaticMarkup(<StatusPill status="done" />)).toContain("text-accent");
    expect(renderToStaticMarkup(<StatusPill status="seated" />)).toContain("bg-accent-soft");
    expect(renderToStaticMarkup(<StatusPill status="voided" />)).toContain("bg-danger-soft");
    expect(renderToStaticMarkup(<StatusPill status="cancelled" />)).toContain("text-danger");
    expect(renderToStaticMarkup(<StatusPill status="late" />)).toContain("bg-attention-soft");
  });

  it("takes another word where the screen needs one", () => {
    expect(renderToStaticMarkup(<StatusPill status="delivered" label="Served" />)).toContain(">Served</span>");
  });
});
